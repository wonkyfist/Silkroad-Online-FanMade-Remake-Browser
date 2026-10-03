/**
 * The World Editor's Routes tool (docs/WORLD_EDITOR.md §4.11, §F4, §F18, D32; WAVE_PLAN8 D12, lane WE-T): the model's
 * changes land in the town file and its `manual` overlay alike (a rebuild on the same graph reproduces them; undo
 * takes them back), dressing props move and go by row id with their bench and stall places, the save refuses red
 * paths and files that changed on disk, the API serves and writes `content/town/` only with the lease, and on the
 * export's navmesh (skipped without one) the edge rule refuses a path through a house and a real `town-graph` rebuild
 * keeps every manual edit.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  JANGAN_GRAPH, buildTownFile, checkTownEdge, dressingRows, exportNpcs, loadTownNav, rowObstacle, townFileText,
  type TownNav,
} from '../../../packages/convert/src/town/build-graph.ts'
import { REPO_ROOT, loadConfig } from '../../../packages/convert/src/node-io.ts'
import { TOWN_UID_BASE } from '../../../packages/convert/src/world/town/dressing.ts'
import { validateTownFile, type TownDressingFile, type TownFile } from '../../../packages/shared/src/town.ts'
import { applyTownManual, townManualCount } from '../../../packages/shared/src/town-manual.ts'
import { createEditorApi, type EditorApi } from '../editor-api/api.ts'
import { API_PREFIX, LEASE_HEADER, TOKEN_HEADER, type SessionInfo } from '../editor-api/protocol.ts'
import { TownEdits, ensureRowIds, type TownChecker } from '../src/editor/town/town-edits.ts'
import { TownStore, townJsonText } from '../src/editor/town/town-store.ts'
import { DRESSING_UID_BASE, JANGAN_HOME } from '../src/editor/town/town-tool.ts'

const TOWN = JSON.parse(readFileSync(join(REPO_ROOT, 'content/town/jangan.json'), 'utf8')) as TownFile
const DRESSING = JSON.parse(readFileSync(join(REPO_ROOT, 'content/town/jangan-dressing.json'), 'utf8')) as TownDressingFile
const clone = <T>(v: T): T => structuredClone(v)
const nodeMap = (f: TownFile) => new Map(f.graph.nodes.map(n => [n.id, `${n.x},${n.z},${n.y ?? ''}`]))
const edgeSet = (f: TownFile) => new Set(f.graph.edges.map(e => [e.a, e.b].sort().join('|')))
const seatList = (f: TownFile) => f.places.map(p => `${p.id}@${p.node}:${(p.seats ?? []).map(s => `${s.x},${s.z},${s.yaw}`).join(';')}`)

const tmps: string[] = []
const apis: EditorApi[] = []
afterEach(() => {
  for (const a of apis.splice(0)) a.close()
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true })
})

describe('the Routes tool: the model and its overlay', () => {
  it('keeps the shared constants (the home point, the dressing uid base)', () => {
    expect(JANGAN_HOME).toEqual(JANGAN_GRAPH.home)
    expect(DRESSING_UID_BASE).toBe(TOWN_UID_BASE)
  })

  it('every change lands in the file and the overlay alike: the overlay on the original file gives the edited file; undo takes it all back', () => {
    const e = new TownEdits({ town: TOWN, dressing: DRESSING })
    const nodes = e.town.graph.nodes
    const free = (a: string, b: string) => !e.town.graph.edges.some(x => (x.a === a && x.b === b) || (x.a === b && x.b === a))
    expect(e.moveNode('n100', nodes.find(n => n.id === 'n100')!.x + 1.5, nodes.find(n => n.id === 'n100')!.z - 0.5)).toBeNull()
    expect(e.removeNode('n200')).toBe(true)
    const n300 = e.node('n300')!
    const added = e.addNode(n300.x + 4, n300.z + 3, 'n300')
    expect(added.problem).toBeNull()
    expect(added.node!.id).toBe('m0')
    const pair = e.town.graph.nodes.slice(400, 460).flatMap(a => e.town.graph.nodes.slice(400, 460).filter(b => b.id !== a.id && free(a.id, b.id)).map(b => [a.id, b.id] as const))[0]!
    expect(e.addEdge(pair[0], pair[1])).toBeNull()
    expect(e.moveNode('m0', added.node!.x + 1, added.node!.z)).toBeNull()
    const cut = e.town.graph.edges[10]!
    expect(e.cutEdge(cut.a, cut.b)).toBe(true)
    const bench = e.town.places.find(p => p.id === 'bench-3')!
    expect(e.moveSeat('bench-3', 0, bench.seats![0]!.x + 0.2, bench.seats![0]!.z, bench.seats![0]!.yaw + 0.5)).toBeNull()
    expect(e.addSeat('bench-3', bench.x + 1, bench.z, 0)).toBeNull()
    expect(e.removeSeat('bench-3', 1)).toBeNull()
    const tea = e.town.places.find(p => p.id === 'tea-2')!
    expect(e.removeSeat('tea-2', 0)).toMatch(/last seat/)
    expect(tea.seats).toHaveLength(1)
    expect(e.manualCount).toBeGreaterThanOrEqual(8)

    const { files, problems } = e.payload()
    expect(problems).toEqual([])
    expect(validateTownFile(files!.town).ok).toBe(true)
    // the rebuild's step on the same graph: the original file + the saved overlay = what the editor shows
    const rebuilt = clone(TOWN)
    const report = applyTownManual(rebuilt, files!.town.manual)
    expect(report.filter(l => l.includes('matches nothing'))).toEqual([])
    expect(nodeMap(rebuilt)).toEqual(nodeMap(files!.town))
    expect(edgeSet(rebuilt)).toEqual(edgeSet(files!.town))
    expect(seatList(rebuilt)).toEqual(seatList(files!.town))
    expect(rebuilt.folk.routes).toEqual(files!.town.folk.routes)
    expect(rebuilt.folk.fixed).toEqual(files!.town.folk.fixed)

    while (e.undo()) { /* all the way back */ }
    expect(e.town).toEqual(TOWN)
    expect(townManualCount(e.log.manual)).toBe(0)
    expect(e.redo()).toBe('Move a path point')
  })

  it('a dressing prop moves by its row id and takes its bench place along; a deleted one takes its places and their agents', () => {
    const e = new TownEdits({ town: TOWN, dressing: DRESSING })
    const row = e.row('plaza-bench-ne-a')!
    const places = e.placesOfRow(row)
    expect(places.map(p => p.kind)).toEqual(['bench'])
    const before = clone(places[0]!)
    expect(e.moveRow('plaza-bench-ne-a', row.x + 3, row.z - 2, row.yaw)).toBeNull()
    const after = e.place(before.id)!
    expect(after.x).toBeCloseTo(before.x + 3, 2)
    expect(after.z).toBeCloseTo(before.z - 2, 2)
    after.seats!.forEach((s, i) => {
      expect(s.x).toBeCloseTo(before.seats![i]!.x + 3, 2)
      expect(s.z).toBeCloseTo(before.seats![i]!.z - 2, 2)
    })
    expect(e.dressing!.props.find(p => p.id === 'plaza-bench-ne-a')).toMatchObject({ x: row.x, z: row.z })
    expect(e.touchedRows.has('plaza-bench-ne-a')).toBe(true)
    // a quarter turn: the seats turn about the prop
    e.moveRow('plaza-bench-ne-a', row.x, row.z, row.yaw + Math.PI / 2)
    expect(e.place(before.id)!.seats![0]!.yaw).toBeCloseTo(before.seats![0]!.yaw + Math.PI / 2, 1)
    // the overlay holds no entry for it: the rebuild makes the bench place from the moved row
    expect(e.manualCount).toBe(0)
    // a stall with its vendor
    const stallRow = e.dressing!.props.find(p => /w_etc0[23]/.test(p.model) && p.id && e.placesOfRow(p).some(q => q.kind === 'stall'))
    if (stallRow) {
      const stall = e.placesOfRow(stallRow).find(q => q.kind === 'stall')!
      expect(e.town.folk.fixed!.some(f => f.place === stall.id)).toBe(true)
      expect(e.removeRow(stallRow.id!)).toBe(true)
      expect(e.place(stall.id)).toBeUndefined()
      expect(e.town.folk.fixed!.some(f => f.place === stall.id)).toBe(false)
      expect(e.dressing!.props.some(p => p.id === stallRow.id)).toBe(false)
    }
    expect(validateTownFile(e.payload().files!.town).ok).toBe(true)
    expect(validateTownFile(e.payload().files!.dressing!).ok).toBe(true)
  })

  it('gives a row without an id one (the editor addresses rows by id, §F4)', () => {
    const d = clone(DRESSING)
    delete d.props[0]!.id
    delete d.banners[0]!.id
    expect(ensureRowIds(d)).toBe(2)
    expect(d.props[0]!.id).toBe('bench-e0')
    expect(d.banners[0]!.id).toBe('banner-e0')
    expect(new Set([...d.props, ...d.banners].map(r => r.id)).size).toBe(d.props.length + d.banners.length)
  })

  it('refuses ground nobody walks on and failing paths, draws red what a move broke, and Save waits for a fix', () => {
    // a fake navmesh: a wall along x = 0; nothing walkable beyond x = 500
    const checker: TownChecker = {
      edge: (a, b) => (Math.sign(a.x) !== Math.sign(b.x) ? 'crosses the wall' : null),
      ground: (x, _z) => (x > 500 ? null : 1),
    }
    const e = new TownEdits({ town: TOWN, dressing: DRESSING }, checker)
    expect(e.addNode(600, -100).problem).toMatch(/not walkable/)
    const west = e.town.graph.nodes.find(n => n.x < -5)!
    expect(e.addNode(5, west.z, west.id).problem).toBe('crosses the wall')
    const east = e.town.graph.nodes.find(n => n.x > 5)!
    expect(e.addEdge(west.id, east.id)).toBe('crosses the wall')
    expect(e.unsaved).toBe(0)
    // moving a west node east turns its paths red
    expect(e.moveNode(west.id, 3, west.z)).toBeNull()
    expect(e.redEdges().length).toBeGreaterThan(0)
    expect(e.payload().files).toBeNull()
    expect(e.payload().problems[0]).toMatch(/red path/)
    e.undo()
    expect(e.redEdges()).toEqual([])
    expect(e.payload().files).not.toBeNull()
  })
})

describe('the Routes tool: saving (the API, content/town only)', () => {
  function sandbox(): { repo: string; work: string; town: string } {
    const root = mkdtempSync(join(tmpdir(), 'sro-town-routes-'))
    tmps.push(root)
    const repo = join(root, 'repo')
    const town = join(repo, 'content', 'town')
    mkdirSync(town, { recursive: true })
    mkdirSync(join(repo, 'content', 'world-edits', 'jangan-fields'), { recursive: true })
    copyFileSync(join(REPO_ROOT, 'content/town/jangan.json'), join(town, 'jangan.json'))
    copyFileSync(join(REPO_ROOT, 'content/town/jangan-dressing.json'), join(town, 'jangan-dressing.json'))
    const work = join(root, 'work')
    mkdirSync(work, { recursive: true })
    return { repo, work, town }
  }

  it('writes the town file exactly as town-graph does (an unchanged save is byte-identical)', () => {
    expect(townJsonText(TOWN)).toBe(townFileText(TOWN))
    expect(townJsonText(TOWN)).toBe(readFileSync(join(REPO_ROOT, 'content/town/jangan.json'), 'utf8'))
  })

  it('loads with base hashes, saves valid files atomically, refuses invalid or changed-on-disk ones', () => {
    const box = sandbox()
    const store = new TownStore(box.town)
    const l = store.load()
    expect(l.problems).toEqual([])
    expect(l.town!.graph.nodes.length).toBe(TOWN.graph.nodes.length)
    const e = new TownEdits({ town: l.town!, dressing: l.dressing })
    e.cutEdge(e.town.graph.edges[0]!.a, e.town.graph.edges[0]!.b)
    const files = e.payload().files!
    const r = store.save({ town: files.town, dressing: files.dressing, base: l.base })
    expect(r.written.length).toBe(2)
    const saved = JSON.parse(readFileSync(join(box.town, 'jangan.json'), 'utf8')) as TownFile
    expect(saved.manual?.cut).toHaveLength(1)
    expect(saved.graph.edges.length).toBe(TOWN.graph.edges.length - 1)
    // the old base: the file changed on disk since (a rebuild): refused, nothing written
    expect(() => store.save({ town: files.town, base: l.base })).toThrow(/changed on disk/)
    // invalid
    const bad = clone(files.town) as unknown as Record<string, unknown>
    bad.manual = { nodes: [{ id: 'x', x: 0, z: 0 }] }
    expect(() => store.save({ town: bad, base: r.base })).toThrow(/does not validate/)
    expect(readFileSync(join(box.town, 'jangan.json'), 'utf8')).toBe(townJsonText(saved))
  })

  it('GET town answers with the token; POST town needs the tab\'s lease', async () => {
    const box = sandbox()
    const api = createEditorApi({ repoRoot: box.repo, workRoot: box.work, world: 'jangan-fields', port: 5185, token: 'tok-0123456789abcdef0123' })
    apis.push(api)
    const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => new Promise<{ status: number; json: () => any }>((resolve, reject) => {
      const headers: Record<string, string> = { host: '127.0.0.1:5185', [TOKEN_HEADER]: 'tok-0123456789abcdef0123', ...extra }
      if (method === 'POST') Object.assign(headers, { origin: 'http://127.0.0.1:5185', 'content-type': 'application/json' })
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
      Object.assign(req, { method, url: API_PREFIX + path, headers })
      const res = {
        statusCode: 200, headersSent: false, setHeader: () => {},
        end: (d?: string | Uint8Array) => resolve({ status: res.statusCode, json: () => JSON.parse(Buffer.from(d ?? '').toString('utf8')) }),
        destroy: () => reject(new Error('destroyed')),
      }
      api.handle(req, res as unknown as ServerResponse, () => reject(new Error('not handled')))
    })
    const got = await call('GET', 'town')
    expect(got.status).toBe(200)
    const load = got.json()
    expect(load.town.kind).toBe('town')
    expect(load.dressing.kind).toBe('townDressing')
    const e = new TownEdits({ town: load.town, dressing: load.dressing })
    e.cutEdge(e.town.graph.edges[0]!.a, e.town.graph.edges[0]!.b)
    const body = { town: e.payload().files!.town, dressing: e.payload().files!.dressing, base: load.base }
    expect((await call('POST', 'town', body)).status).toBe(409)
    const session = (await call('POST', 'session', {})).json() as SessionInfo
    const ok = await call('POST', 'town', body, { [LEASE_HEADER]: session.lease! })
    expect(ok.status).toBe(200)
    expect((JSON.parse(readFileSync(join(box.town, 'jangan.json'), 'utf8')) as TownFile).manual?.cut).toHaveLength(1)
    // a stale base: 400 with the sentence
    const stale = await call('POST', 'town', body, { [LEASE_HEADER]: session.lease! })
    expect(stale.status).toBe(400)
    expect(stale.json().error).toMatch(/changed on disk/)
  })
})

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const workDir = hasConfig ? loadConfig().workDir : ''
const worldDir = hasConfig ? join(workDir, 'out', 'world', 'jangan-fields') : ''
const hasExport = hasConfig && existsSync(join(worldDir, 'nav.bin'))

describe.skipIf(!hasExport)('the Routes tool on the export\'s navmesh (work/out/world/jangan-fields)', () => {
  let navCache: { nav: TownNav; manifest: Parameters<typeof dressingRows>[1] } | null = null
  const load = () => {
    if (navCache) return navCache
    const { nav, manifest } = loadTownNav(worldDir, JANGAN_GRAPH)
    nav.obstacles = dressingRows(DRESSING, manifest).map(rowObstacle)
    return (navCache = { nav, manifest })
  }
  const checkerOf = (nav: TownNav): TownChecker => ({
    edge: (a, b) => checkTownEdge(nav, a, b),
    ground: (x, z, hint) => nav.ground(x, z, hint ?? Infinity)?.y ?? null,
  })

  it('the edge rule passes the generated paths and refuses one through a house', () => {
    const { nav } = load()
    const byId = new Map(TOWN.graph.nodes.map(n => [n.id, n]))
    for (const ed of TOWN.graph.edges.filter((_, i) => i % 97 === 0)) expect(nav.checkSegment(byId.get(ed.a)!.x, byId.get(ed.a)!.z, byId.get(ed.a)!.y ?? Infinity, byId.get(ed.b)!.x, byId.get(ed.b)!.z, byId.get(ed.b)!.y ?? Infinity), `${ed.a}-${ed.b}`).toBeNull()
    // two plaza-side nodes on either side of a house: a straight path between doors' nodes across the smithy block
    const door = TOWN.places.find(p => p.kind === 'door' && p.id.startsWith('door-'))!
    const n = byId.get(door.node)!
    // through the house the door belongs to: from the door's node 25 m straight in (away from the street)
    const inward = { id: 'x', x: door.x - Math.sin(door.yaw) * 25, z: door.z - Math.cos(door.yaw) * 25, y: n.y }
    expect(checkTownEdge(nav, n, inward)).not.toBeNull()
  }, 120_000)

  it('a town-graph rebuild keeps every manual edit (the editor\'s file = the rebuilt file)', () => {
    const { nav } = load()
    const e = new TownEdits({ town: TOWN, dressing: DRESSING }, checkerOf(nav))
    // a plaza node moved 1 m (the first that keeps all its paths walkable)
    const plaza = e.town.graph.nodes.filter(n => Math.hypot(n.x - 97, n.z + 110) < 40 && n.id.startsWith('n'))
    let moved: string | null = null
    for (const n of plaza) {
      const x = n.x
      const z = n.z
      if (e.moveNode(n.id, x + 1, z) === null && e.redEdges().length === 0) {
        moved = n.id
        break
      }
      e.undo()
    }
    expect(moved).not.toBeNull()
    // a new point joined to a plaza node
    let added: string | null = null
    for (const n of plaza.slice(5)) {
      for (let k = 0; k < 8 && !added; k++) {
        const a = (k / 8) * Math.PI * 2
        const r = e.addNode(n.x + Math.sin(a) * 5, n.z + Math.cos(a) * 5, n.id)
        if (r.node) added = r.node.id
      }
      if (added) break
    }
    expect(added).toBe('m0')
    // a path cut, a seat added to a bench
    const cut = e.town.graph.edges.find(x => x.a === plaza[10]!.id || x.b === plaza[10]!.id)!
    expect(e.cutEdge(cut.a, cut.b)).toBe(true)
    const bench = e.town.places.find(p => p.kind === 'bench' && p.id.startsWith('bench-'))!
    expect(e.addSeat(bench.id, bench.x + 0.8, bench.z, bench.yaw)).toBeNull()
    expect(e.redEdges()).toEqual([])
    const saved = e.payload().files!.town
    expect(townManualCount(saved.manual)).toBe(5)

    const npcs = exportNpcs(join(workDir, 'out')).filter(n => n.x > -200 && n.x < 400 && n.z > -400 && n.z < 20)
    const { file, report } = buildTownFile(worldDir, JANGAN_GRAPH, saved, DRESSING, npcs)
    expect(report.filter(l => l.startsWith('manual:') && !l.startsWith('manual: 5 hand edits applied'))).toEqual([])
    expect(file.manual).toEqual(saved.manual)
    expect(nodeMap(file)).toEqual(nodeMap(saved))
    expect(edgeSet(file)).toEqual(edgeSet(saved))
    expect(seatList(file)).toEqual(seatList(saved))
    expect(validateTownFile(file).ok).toBe(true)
    // the hand-made paths lie on the navmesh
    const byId = new Map(file.graph.nodes.map(n => [n.id, n]))
    for (const ed of file.graph.edges.filter(x => [x.a, x.b].some(id => id === moved || id === added))) {
      expect(checkTownEdge(nav, byId.get(ed.a)!, byId.get(ed.b)!), `${ed.a}-${ed.b}`).toBeNull()
    }
  }, 180_000)
})
