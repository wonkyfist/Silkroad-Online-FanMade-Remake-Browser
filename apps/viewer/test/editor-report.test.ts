// WE-U2 (docs/WORLD_EDITOR.md §2.4, §5, §6.2, §6.4, D34, D41; docs/WAVE_PLAN8.md §6.0 step 2, lane WE-U): the page's
// side of Publish. The report in plain English (what changed, what closed for walking and why, the checks with a way
// out and the objects to show, budgets, Keep only for a complete report without a stop), the API record as the page
// reads it, the page's views for the before / after pictures, the Publish flow and Test in game against a fake editor
// API (WE-A's routes), and the cameras the changes record.
import { describe, expect, it } from 'vitest'
import { PUBLISH_CHECKS, type WorldEditsReport } from '../../../packages/convert/src/world/edits/checks.ts'
import { regionIdOf } from '../../../packages/shared/src/world-edits/index.ts'
import { emptyJournal, planJournalRecords } from '../editor-api/journal.ts'
import type { DeployState, PublishRecord, PublishState, TestGameState } from '../editor-api/protocol.ts'
import { decodeChange, displayName, encodeChange, objectLabel, setDisplayNames, type Change } from '../src/editor/history.ts'
import {
  HttpPublishBackend, NO_PUBLISH, PublishApiError, PublishFlow, TestInGame, runOf, testOf,
  type GameWindow, type PublishBackend, type PublishRecordReport,
} from '../src/editor/publish.ts'
import {
  RegionNames, adviceFor, changeLines, checkItems, checkRefs, closedLines, escapeHtml, mergeRepeats, placeTitle, refOfKey, reportModel,
  sheetViews, type PublishRunView, type TestInGameView,
} from '../src/editor/publish-report.ts'
import { EditSession } from '../src/editor/session.ts'

const R = regionIdOf(171, 97)
const names = new RegionNames([{ name: 'hill-of-ye-mt', x: 819, z: -107 }, { name: 'jangan', x: 96, z: -192 }], id => (id === R ? { x: 900, z: -150 } : null))

type Status = 'pass' | 'warn' | 'stop' | 'skip'
function report(over: Partial<Record<(typeof PUBLISH_CHECKS)[number]['key'], { status: Status; summary?: string; details?: unknown }>> = {}): WorldEditsReport {
  const checks = PUBLISH_CHECKS.map(c => ({ id: c.id, key: c.key, title: c.title, status: over[c.key]?.status ?? 'pass', summary: over[c.key]?.summary ?? `${c.title}: fine.`, ...(over[c.key]?.details !== undefined ? { details: over[c.key]!.details } : {}) }))
  const statuses = checks.map(c => c.status)
  return {
    format: 'sro-world-edits-report', version: 1, world: 'jangan-fields',
    verdict: statuses.includes('stop') ? 'stop' : statuses.includes('warn') ? 'warn' : 'pass',
    complete: !statuses.includes('skip'),
    checks,
    nav: {
      regions: [{
        region: R, x: 171, z: 97, name: '171_97', touched: 443, closedSlope: 117, closedWater: 0, forcedOpen: 0, forcedClosed: 0, closed: 117, opened: 0,
        closedTiles: [], openedTiles: [], planesSet: 0, objects: { removed: 0, replaced: 1, added: 0 },
      }],
      totals: { touched: 443, closed: 117, opened: 0, closedSlope: 117, closedWater: 0, objects: 1 },
      problems: [],
    },
    swim: { deepWaterTiles: 0, deepWaterM2: 0, regions: [] },
    timingsMs: {},
  }
}

const change = (id: number, label: string, state = 'done', regions = [R]) => ({ id, label, state, regions })

describe('names', () => {
  it('turns place slugs and region ids into words', () => {
    expect(placeTitle('hill-of-ye-mt')).toBe('Hill of Ye Mt')
    expect(placeTitle('enterance-of-qin-shi-tomb')).toBe('Enterance of Qin Shi Tomb')
    expect(RegionNames.parse('171_97')).toBe(R)
    expect(RegionNames.parse('171,97')).toBe(R)
    expect(names.label(R)).toBe('171,97 (Hill of Ye Mt)')
    expect(names.labelOf('171_97')).toBe('171,97 (Hill of Ye Mt)')
    expect(names.label(regionIdOf(10, 10))).toBe('10,10')
    expect(escapeHtml('<b>"a" & \'b\'</b>')).toBe('&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;')
  })

  it('names a placed new tree by its species, not its carrier file', () => {
    const carrier = 'res\\nature\\china\\tree\\tre_maple03.bsr'
    const item = { ref: 'ed-1', before: null, after: { source: carrier, position: [0, 0, 0] as [number, number, number], yaw: 0, scale: 1 } }
    setDisplayNames([])
    expect(objectLabel('Placed', { items: [item] })).toBe('Placed tre_maple03')
    setDisplayNames([[carrier.toUpperCase(), 'Maple']])
    expect(displayName(carrier)).toBe('Maple')
    expect(objectLabel('Placed', { items: [item, { ...item, ref: 'ed-2' }] })).toBe('Placed 2 × Maple')
    setDisplayNames([])
  })
})

describe('the report in plain English', () => {
  it('says what closed for walking and why', () => {
    const lines = closedLines(report(), names)
    expect(lines[0]).toBe('Region 171,97 (Hill of Ye Mt): 117 tiles (468 m²) closed because the new slopes are steeper than 35°: players walk around them; 1 walking footprint moved with its object.')
    const quiet = report()
    quiet.nav.regions = []
    quiet.nav.totals = { touched: 0, closed: 0, opened: 0, closedSlope: 0, closedWater: 0, objects: 0 }
    expect(closedLines(quiet, names)).toEqual(['No walking changed: your edits keep every path as it was.'])
    const cut = report({ cutOff: { status: 'warn', details: { cutOffM2: 48, cut: [{ region: '171_97', tiles: [1, 2, 3] }] } } })
    expect(closedLines(cut, names).at(-1)).toContain('48 m² of open ground can\'t be reached from town')
  })

  it('gives every amber or red row a way out, and none to a green one', () => {
    for (const c of PUBLISH_CHECKS) {
      expect(adviceFor(c.key, 'pass')).toBeUndefined()
      expect(adviceFor(c.key, 'skip')).toBeUndefined()
      for (const s of ['warn', 'stop'] as const) expect(adviceFor(c.key, s)).toMatch(/^[A-Z].+[.:]/)
    }
  })

  it('names the objects and points behind a row, and which object to show', () => {
    const r = report({
      props: { status: 'warn', details: { props: [{ key: '171_97:33794', model: 'tre_tree01.bsr', moved: false, clearanceChangeM: -10.7, footprintMovedM: 10.3, verdict: 'buried' }, { key: '171_97:57344', model: 'stone03.bsr', clearanceChangeM: 0.6, verdict: 'floating' }] } },
      reachable: { status: 'stop', details: { checked: 53, lost: [{ kind: 'nest', id: '17', name: 'Bandit', x: 812.4, z: -99.6 }] } },
      overlaps: { status: 'warn', details: { overlaps: [{ a: '171_97:40', b: '171_97:41', overlapM2: 3.25 }] } },
    })
    const propsRow = r.checks.find(c => c.key === 'props')!
    const props = checkItems(propsRow, names)
    expect(props[0]).toBe('tre_tree01 in region 171,97 (Hill of Ye Mt) is 10.7 m under the new ground')
    expect(props[1]).toBe('stone03 in region 171,97 (Hill of Ye Mt) floats 0.6 m above the new ground')
    // a retail object can be selected; an editor add (uid 0xE000+) has no ref in the report's key
    expect(checkRefs(propsRow)).toEqual([`r:${R}:33794`, null])
    expect(refOfKey('171_97:33794')).toBe(`r:${R}:33794`)
    expect(refOfKey('nonsense')).toBeNull()
    expect(checkItems(r.checks.find(c => c.key === 'reachable')!, names)[0]).toBe('the monster nest Bandit at 812, -100 can\'t be reached from town any more')
    const overlaps = r.checks.find(c => c.key === 'overlaps')!
    expect(checkItems(overlaps, names)[0]).toBe('Two walking footprints in region 171,97 (Hill of Ye Mt) overlap by 3.3 m²')
    expect(checkRefs(overlaps)).toEqual([`r:${R}:40`])
    const model = reportModel({ id: 1, state: 'ready', report: r }, [], names)
    expect(model.checks.find(c => c.title === 'Props on moved ground')!.refs).toEqual([`r:${R}:33794`, null])
    const many = report({ props: { status: 'warn', details: { props: Array.from({ length: 12 }, (_, i) => ({ key: `171_97:${i}`, model: 'm', clearanceChangeM: 1, verdict: 'floating' })) } } })
    const manyRow = many.checks.find(c => c.key === 'props')!
    const items = checkItems(manyRow, names)
    expect(items).toHaveLength(9)
    expect(items[8]).toBe('… and 4 more')
    expect(checkRefs(manyRow)).toHaveLength(9)
    expect(checkRefs(manyRow)[8]).toBeNull()
  })

  it('lets Keep through only for a finished, complete report without a stop', () => {
    const done = (r: WorldEditsReport, state: PublishRunView['state'] = 'ready') => reportModel({ id: 3, state, report: r }, [], names)
    expect(done(report()).keep.enabled).toBe(true)
    expect(done(report()).tone).toBe('ok')
    expect(done(report()).headline).toBe('Everything checks out.')
    const warn = done(report({ overlaps: { status: 'warn' } }))
    expect(warn.keep.enabled).toBe(true)
    expect(warn.tone).toBe('warn')
    const stop = done(report({ roads: { status: 'stop', summary: '1 gate lost its way.' } }), 'stopped')
    expect(stop.keep.enabled).toBe(false)
    expect(stop.headline).toBe('Publish stopped: 1 gate lost its way.')
    expect(stop.goBack).toBe(true)
    expect(stop.testInGame.enabled).toBe(true)
    expect(done(report({ roads: { status: 'stop' } })).keep.why).toBe('A red row stops the Publish.')
    const partial = done(report({ tests: { status: 'skip' } }))
    expect(partial.keep.enabled).toBe(false)
    expect(partial.keep.why).toContain('complete report')
    expect(partial.checks.find(c => c.title === 'Tests')!.tone).toBe('muted')
    const running = reportModel({ id: 3, state: 'running', steps: [{ key: 'a', label: 'Checking the layers', state: 'done', ms: 120 }, { key: 'b', label: 'Re-building 4 regions', state: 'running' }] }, [], names)
    expect(running.headline).toBe('Publishing… Re-building 4 regions (step 2 of 2)')
    expect(running.keep.enabled).toBe(false)
    expect(running.testInGame.enabled).toBe(false)
    const failed = reportModel({ id: 3, state: 'failed', error: 'the convert lock is held by "X2".' }, [], names)
    expect(failed.headline).toBe('Publish could not finish: the convert lock is held by "X2".')
    expect(failed.detail).toContain('Nothing changed on the map')
    const kept = reportModel({ id: 3, state: 'kept', commit: 'a1b2c3d' }, [], names)
    expect(kept.detail).toContain('saved in git (a1b2c3d)')
    expect(kept.testInGame.enabled).toBe(false)
    expect(kept.undo).toBe(true)
    const keeping = reportModel({ id: 3, state: 'running', job: 'keep', steps: [{ key: 'keep-swap', label: 'Put the files in place', state: 'running' }] }, [], names)
    expect(keeping.headline).toBe('Keeping… Put the files in place (step 1 of 1)')
    const waiting = reportModel({ id: 3, state: 'running', waiting: 'X2 convert 08:40' }, [], names)
    expect(waiting.detail).toContain('Waiting for another build to finish first (X2 convert 08:40)')
    const notes = reportModel({ id: 3, state: 'ready', report: report(), hero: ['c_dust_fld_02', 'c_grass_fld_01'], drift: 1 }, [], names)
    expect(notes.notes[0]).toBe('Keep turns on the upscaled maps of 2 ground textures you painted widely (c_dust_fld_02, c_grass_fld_01).')
    expect(notes.notes[1]).toContain('1 file of the map on this PC differs')
    expect(reportModel({ id: 3, state: 'undone' }, [], names).headline).toBe('This publish is undone.')
  })

  it('lists the budgets of the changed regions', () => {
    const r = report({ budgets: { status: 'warn', details: { regions: [{ region: '171_97', before: { objectTriangles: 3207, placements: 120, models: 30, separateDraws: 1 }, after: { objectTriangles: 64000, placements: 123, models: 31, separateDraws: 1 }, status: 'warn', benchNeeded: true }], world: { treeSlots: { before: 5586, after: 5589, status: 'pass' } } } } })
    const m = reportModel({ id: 1, state: 'ready', report: r }, [], names)
    expect(m.budgets[0]).toBe('Region 171,97 (Hill of Ye Mt): object triangles 3,207 → 64,000, objects 120 → 123, different models 30 → 31, over the warning line (grew enough to need the speed check)')
    expect(m.budgets[1]).toBe('Trees world-wide: 5,586 → 5,589 (the line is 7,500)')
    expect(m.checks.find(c => c.title === 'Budgets')!.items).toHaveLength(1)
  })

  it('words the changes: the API list first, else the page journal; repeats become one line', () => {
    const list = [change(1, 'Raised the ground in 171,97 (up to 2.30 m, 1,204 points)'), change(2, 'Painted Dirt 3 in 171,97 (300 points)'), change(3, 'Placed Maple'), change(4, 'Placed Maple'), change(5, 'Placed Maple'), change(6, 'Moved lamp01 4.2 m', 'reverted'), change(7, 'Moved lamp01 3.0 m')]
    const lines = changeLines(list, names)
    expect(lines).toEqual([
      'Raised the ground in 171,97 (up to 2.30 m, 1,204 points), near Hill of Ye Mt',
      'Painted Dirt 3 in 171,97 (300 points), near Hill of Ye Mt',
      'Placed Maple, near Hill of Ye Mt (×3)',
      'Moved lamp01 3.0 m, near Hill of Ye Mt',
    ])
    expect(mergeRepeats(['a', 'a', 'b', 'a'])).toEqual(['a (×2)', 'b', 'a'])
    expect(reportModel({ id: 1, state: 'ready', report: report(), changes: ['Moved lamp01 3.0 m', 'Moved lamp01 3.0 m'] }, list, names).changes).toEqual(['Moved lamp01 3.0 m (×2)'])
    expect(reportModel({ id: 1, state: 'ready', report: report(), changes: [] }, list, names).changes).toHaveLength(4)
    const twenty = Array.from({ length: 20 }, (_, i) => change(i + 1, `Moved rock${i} 1.0 m`, 'done', []))
    const many = changeLines(twenty, names)
    expect(many).toHaveLength(13)
    expect(many[0]).toBe('… 8 earlier changes')
  })

  it('picks the page views for the pictures: starred first, 30 m apart, at most eight', () => {
    const v = (x: number) => [x, 50, 0, x, 0, 10]
    const list = [
      { ...change(1, 'a'), view: v(0) }, { ...change(2, 'b'), view: v(10) }, { ...change(3, 'c'), view: v(100), starred: true },
      { ...change(4, 'd', 'undone'), view: v(300) }, { ...change(5, 'e'), view: v(200) }, { ...change(6, 'f') },
    ]
    const views = sheetViews(list)
    expect(views.map(x => x.id)).toEqual([3, 5, 2])
    expect(views[0]).toEqual({ id: 3, label: 'c', view: [100, 50, 0, 100, 0, 10], starred: true })
    const many = Array.from({ length: 10 }, (_, i) => ({ ...change(i + 1, `m${i}`), view: v(i * 100) }))
    expect(sheetViews(many)).toHaveLength(8)
  })
})

describe('the changes record their camera', () => {
  it('keeps the view and the star through the journal', () => {
    const s = new EditSession({ world: 'jangan-fields', originRegion: { x: 168, z: 97 }, regions: [R], placements: [], host: { heights: () => null, words: () => null } })
    s.viewOf = () => [1.234, 50, -3, 4, 0.5, -6.789]
    const c = s.record({}, 'Something', [R])
    expect(c.view).toEqual([1.23, 50, -3, 4, 0.5, -6.79])
    c.starred = true
    const back = decodeChange(JSON.parse(JSON.stringify(encodeChange(c))) as Record<string, unknown>)
    expect(back.view).toEqual(c.view)
    expect(back.starred).toBe(true)
    const plain: Change = { id: 9, at: 'x', label: 'y', state: 'done', regions: [] }
    expect(encodeChange(plain)).not.toHaveProperty('view')
    expect(decodeChange({ ...encodeChange(plain), view: [1, 2, 'x', 4, 5, 6] }).view).toBeUndefined()
    // the API's journal keeps them (its publish lists the views, starred first, and Test in game starts there)
    const plan = planJournalRecords('/nowhere', emptyJournal('jangan-fields'), [encodeChange(c), encodeChange(plain), { ...encodeChange({ ...plain, id: 10 }), view: [1, 2, 3] }], {})
    expect(plan.next.entries.map(e => [e.id, e.view, e.starred])).toEqual([[c.id, c.view, true], [9, undefined, undefined], [10, undefined, undefined]])
  })
})

// ---- the flow against a fake API ----------------------------------------------------------------------------------------

function record(n: number, phase: PublishRecord['phase'], over: Partial<PublishRecord> = {}): PublishRecord {
  return {
    format: 'sro-editor-publish', version: 1, n, world: 'jangan-fields', phase, startedAt: 't', steps: [], sentence: `${phase}.`,
    changes: ['Raised the ground in 171,97'], journalId: 9, ...over,
  }
}
const st = (current: PublishRecord | null, running: PublishState['running'] = null): PublishState => ({ current, lastKept: null, running, convertLock: null })
const job = (j: 'prepare' | 'keep' | 'discard' | 'undo', n: number) => ({ job: j, n, since: 't' })
const VIEWS = [{ id: 5, label: 'Raised the ground', view: [1, 50, 2, 1, 0, 12] }]

class FakeBackend implements PublishBackend {
  calls: string[] = []
  states: PublishState[] = []
  reports = new Map<number, PublishRecordReport>()
  tests: TestGameState[] = []
  fail: Error | null = null
  shots: string[] = []
  private next(): PublishState {
    return this.states.length > 1 ? this.states.shift()! : this.states[0] ?? st(null)
  }
  async state(): Promise<PublishState> {
    this.calls.push('state')
    return this.next()
  }
  async start(): Promise<PublishState> {
    this.calls.push('start')
    if (this.fail) throw this.fail
    return this.next()
  }
  async keep(n: number): Promise<PublishState> {
    this.calls.push(`keep ${n}`)
    return this.next()
  }
  async discard(n: number): Promise<PublishState> {
    this.calls.push(`discard ${n}`)
    return this.next()
  }
  async undo(n: number): Promise<PublishState> {
    this.calls.push(`undo ${n}`)
    return this.next()
  }
  async report(n: number): Promise<PublishRecordReport> {
    this.calls.push(`report ${n}`)
    return this.reports.get(n)!
  }
  async page(): Promise<string> {
    return '<html></html>'
  }
  async shot(n: number, name: string, png: string): Promise<void> {
    this.shots.push(`${n} ${name} ${png}`)
  }
  async test(): Promise<TestGameState> {
    this.calls.push('test')
    return this.tests.shift() ?? { phase: 'failed', sentence: 'gone' }
  }
  async testStart(): Promise<TestGameState> {
    this.calls.push('testStart')
    if (this.fail) throw this.fail
    return this.tests.shift() ?? { phase: 'starting', sentence: 'Starting.' }
  }
  async testStop(keepalive = false): Promise<TestGameState> {
    this.calls.push(`testStop${keepalive ? ' keepalive' : ''}`)
    return { phase: 'off', sentence: 'Stopped.' }
  }
  async deploy(): Promise<DeployState> {
    return { ok: false, sentence: 'Publish first.', changes: [] }
  }
  async deployRun(): Promise<DeployState> {
    return { ok: false, sentence: 'no', changes: [] }
  }
}

function flowHost(over: { save?: boolean; nothing?: boolean; fallback?: boolean } = {}) {
  const shown: PublishRunView[] = []
  const said: Array<[string, string | undefined]> = []
  const shotViews: number[][] = []
  let saves = 0
  const host = {
    save: async () => (saves++, over.save ?? true),
    hasChanges: () => !over.nothing,
    show: (r: PublishRunView) => shown.push(r),
    say: (t: string, k?: 'ok' | 'warn' | 'error') => said.push([t, k]),
    takeShots: async (views: NonNullable<PublishRecord['views']>) => {
      shotViews.push(views.map(v => v.id))
      return views.map(v => ({ view: v.id, label: v.label, before: `blob:b${v.id}`, after: `blob:a${v.id}`, beforePng: 'BB', afterPng: 'AA' }))
    },
    ...(over.fallback ? { fallbackViews: () => [{ id: 77, label: 'page view', view: [0, 1, 2, 3, 4, 5] }] } : {}),
  }
  return { host, shown, said, shotViews, saves: () => saves }
}

const noSleep = { sleep: async () => {} }

describe('the API record as the report reads it', () => {
  it('maps phases, steps, jobs and the checks', () => {
    const rec = record(3, 'preparing', { steps: [{ key: 'validate', title: 'Check the layers', status: 'done', ms: 40 }, { key: 'convert', title: 'Re-build 4 regions', status: 'run' }], regions: { core: [R], ring: [], nav: [] } })
    const run = runOf(st(rec, job('prepare', 3)), null)!
    expect(run).toMatchObject({ id: 3, state: 'running', job: 'prepare', regions: [R], changes: ['Raised the ground in 171,97'] })
    expect(run.steps).toEqual([{ key: 'validate', label: 'Check the layers', state: 'done', ms: 40 }, { key: 'convert', label: 'Re-build 4 regions', state: 'running' }])
    const ready = record(3, 'ready', { tests: { ok: true, files: [], summary: '12 tests passed.' }, hero: [{ tile: 'c_dust_fld_02', cover: 0.004 }], drift: ['a.bin'] })
    const r2 = runOf(st(ready), { ...ready, report: report() })!
    expect(r2).toMatchObject({ state: 'ready', tests: '12 tests passed.', hero: ['c_dust_fld_02'], drift: 1 })
    expect(r2.report?.verdict).toBe('pass')
    // a report of another publish is never shown with this one
    expect(runOf(st(ready), { ...record(2, 'ready'), report: report() })!.report).toBeNull()
    // keep runs on a ready record: the run is busy
    expect(runOf(st(ready, job('keep', 3)), null)!.state).toBe('running')
    expect(runOf(st(record(4, 'undone')), null)!.state).toBe('undone')
    expect(runOf(st(null), null)).toBeNull()
    expect(testOf({ phase: 'running', url: 'http://127.0.0.1:5481/', sentence: 'Running.' })).toEqual({ state: 'ready', url: 'http://127.0.0.1:5481/', message: 'Running.' })
    expect(testOf({ phase: 'failed', sentence: 'x', error: 'the port is busy' })).toEqual({ state: 'failed', message: 'the port is busy' })
  })
})

describe('Publish from the page', () => {
  it('saves, starts, follows the steps, takes the pictures once and lands on the report', async () => {
    const b = new FakeBackend()
    const prep = record(4, 'preparing', { steps: [{ key: 'a', title: 'Check', status: 'run' }] })
    const ready = record(4, 'ready', { views: VIEWS })
    b.states = [st(prep, job('prepare', 4)), st(prep, job('prepare', 4)), st(ready)]
    b.reports.set(4, { ...ready, report: report() })
    const h = flowHost()
    const f = new PublishFlow(b, h.host, noSleep)
    const r = await f.start()
    expect(h.saves()).toBe(1)
    expect(r?.state).toBe('ready')
    expect(b.calls).toEqual(['start', 'state', 'state', 'report 4'])
    expect(h.shotViews).toEqual([[5]])
    expect(b.shots).toEqual(['4 5-before BB', '4 5-after AA'])
    expect(f.run?.sheet).toEqual([{ label: 'Raised the ground', before: 'blob:b5', after: 'blob:a5' }])
    expect(h.said.at(-1)![0]).toContain('everything checks out')
    // a second Publish… while one waits for Keep only shows it
    await f.start()
    expect(b.calls.filter(c => c === 'start')).toHaveLength(1)
    expect(h.said.at(-1)![0]).toContain('Keep it or Go back first')
    // Keep: the job runs, then the record is kept
    b.states = [st(ready, job('keep', 4)), st(record(4, 'kept', { commit: 'abc1234' }))]
    const kept = await f.keep()
    expect(kept?.state).toBe('kept')
    expect(kept?.commit).toBe('abc1234')
    expect(b.calls).toContain('keep 4')
    expect(h.shotViews).toHaveLength(1)
    // Undo this publish
    b.states = [st(record(4, 'kept'), job('undo', 4)), st(record(4, 'undone'))]
    expect((await f.undo())?.state).toBe('undone')
  })

  it('uses the page\'s own views when the record lists none', async () => {
    const b = new FakeBackend()
    b.states = [st(record(6, 'ready'))]
    b.reports.set(6, { ...record(6, 'ready'), report: report() })
    const h = flowHost({ fallback: true })
    await new PublishFlow(b, h.host, noSleep).start()
    expect(h.shotViews).toEqual([[77]])
    expect(b.shots[0]).toBe('6 77-before BB')
  })

  it('goes back, and never starts without a save or a change', async () => {
    const b = new FakeBackend()
    const stopped = record(4, 'stopped')
    b.states = [st(stopped)]
    b.reports.set(4, { ...stopped, report: report({ traps: { status: 'stop' } }) })
    const h = flowHost()
    const f = new PublishFlow(b, h.host, noSleep)
    expect((await f.start())?.state).toBe('stopped')
    expect(h.said.at(-1)).toEqual(['Publish stopped: see the red rows. Nothing changed on the map.', 'error'])
    expect(h.shotViews).toEqual([])
    expect(f.ready).toBe(true) // Test in game may walk a stopped build
    expect((await f.keep())?.state).toBe('stopped')
    b.states = [st(record(4, 'discarded'))]
    expect((await f.goBack())?.state).toBe('discarded')
    const unsaved = new FakeBackend()
    expect(await new PublishFlow(unsaved, flowHost({ save: false }).host, noSleep).start()).toBeNull()
    expect(await new PublishFlow(unsaved, flowHost({ nothing: true }).host, noSleep).start()).toBeNull()
    expect(unsaved.calls).toEqual([])
  })

  it('says plainly when the API has no Publish yet', async () => {
    const b = new FakeBackend()
    b.fail = new PublishApiError(404, NO_PUBLISH, true)
    const h = flowHost()
    const r = await new PublishFlow(b, h.host, noSleep).start()
    expect(r?.state).toBe('failed')
    expect(h.said.at(-1)).toEqual([NO_PUBLISH, 'error'])
  })

  it('follows publish 1 whose record is not written yet when start answers, to the end (V-12: stuck on "Starting")', async () => {
    const b = new FakeBackend()
    const prep = record(1, 'preparing', { steps: [{ key: 'a', title: 'Check', status: 'run' }, { key: 'b', title: 'Build', status: 'wait' }] })
    const ready = record(1, 'ready')
    // the older API's answer: no record at all yet (publish 1), the job running
    b.states = [st(null, job('prepare', 1)), st(null, job('prepare', 1)), st(prep, job('prepare', 1)), st(ready)]
    b.reports.set(1, { ...ready, report: report() })
    const h = flowHost()
    const f = new PublishFlow(b, h.host, noSleep)
    const r = await f.start()
    expect(r).toMatchObject({ id: 1, state: 'ready' })
    expect(b.calls).toEqual(['start', 'state', 'state', 'state', 'report 1'])
    expect(h.shown.at(-1)).toMatchObject({ id: 1, state: 'ready' })
    expect(h.shown.some(s => s.steps?.[0]?.label === 'Check')).toBe(true)
    expect(h.said.at(-1)![0]).toContain('everything checks out')
  })

  it('shows the new publish, never the previous kept one, while its record is not written yet', async () => {
    const b = new FakeBackend()
    const ready = record(2, 'ready')
    b.states = [st(record(1, 'kept'), job('prepare', 2)), st(ready)]
    b.reports.set(2, { ...ready, report: report() })
    const h = flowHost()
    const r = await new PublishFlow(b, h.host, noSleep).start()
    expect(r).toMatchObject({ id: 2, state: 'ready' })
    expect(h.shown.every(s => s.id !== 1)).toBe(true)
    expect(h.shown.filter(s => s.state === 'kept')).toHaveLength(0)
  })

  it('says so when the job ends without writing its record, instead of staying on "Starting"', async () => {
    const b = new FakeBackend()
    b.states = [st(null, job('prepare', 1)), st(null)]
    const h = flowHost()
    const r = await new PublishFlow(b, h.host, noSleep).start()
    expect(r?.state).toBe('failed')
    expect(h.said.at(-1)![0]).toMatch(/publish 1 ended before it wrote its record/)
  })

  it('a poke (the tab shown again, Publish… pressed) asks the API without waiting for the poll', async () => {
    const b = new FakeBackend()
    b.states = [st(null, job('prepare', 3)), st(record(3, 'ready'))]
    b.reports.set(3, { ...record(3, 'ready'), report: report() })
    const h = flowHost()
    // a hidden tab: the poll's timer never fires on its own
    const f = new PublishFlow(b, h.host, { sleep: () => new Promise<void>(() => {}) })
    const p = f.start()
    for (let i = 0; i < 10 && b.calls.length < 1; i++) await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    expect(b.calls).toEqual(['start'])
    f.poke()
    expect((await p)?.state).toBe('ready')
    expect(b.calls).toEqual(['start', 'state', 'report 3'])
  })

  it('a reload during a prepare that has no record yet follows it', async () => {
    const b = new FakeBackend()
    b.states = [st(null, job('prepare', 1)), st(record(1, 'ready'))]
    b.reports.set(1, { ...record(1, 'ready'), report: report() })
    const h = flowHost()
    expect(await new PublishFlow(b, h.host, noSleep).resume()).toMatchObject({ id: 1, state: 'ready' })
    expect(h.shown[0]).toMatchObject({ id: 1, state: 'running' })
  })

  it('comes back to a publish that waits for Keep after a reload, and leaves a finished one closed', async () => {
    const b = new FakeBackend()
    b.states = [st(record(7, 'ready'))]
    b.reports.set(7, { ...record(7, 'ready'), report: report() })
    const h = flowHost()
    const f = new PublishFlow(b, h.host, noSleep)
    expect((await f.resume())?.id).toBe(7)
    expect(h.said[0]![0]).toContain('waiting for you')
    const b2 = new FakeBackend()
    b2.states = [st(record(8, 'kept'))]
    const h2 = flowHost()
    expect(await new PublishFlow(b2, h2.host, noSleep).resume()).toBeNull()
    expect(h2.shown).toHaveLength(0)
  })
})

describe('the HTTP side', () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('calls the API\'s routes and turns a missing route into the plain sentence', async () => {
    const seen: string[] = []
    const b = new HttpPublishBackend(async (method, path, body, init) => {
      seen.push(`${method} ${path}${body !== undefined ? ` ${JSON.stringify(body)}` : ''}${init?.keepalive ? ' keepalive' : ''}`)
      if (path === 'publish') return res(200, st(null))
      if (path === 'test/stop') return res(200, { phase: 'off', sentence: 'Stopped.' })
      if (path === 'publish/shot') return res(200, { ok: true })
      return res(404, { ok: false, error: `no such editor API route: ${method} ${path}` })
    })
    await expect(b.start()).rejects.toMatchObject({ missing: true, message: NO_PUBLISH })
    expect((await b.state()).current).toBeNull()
    expect((await b.testStop(true)).phase).toBe('off')
    await b.shot(3, '5-before', 'iVBOR')
    await expect(b.keep(3)).rejects.toMatchObject({ missing: true })
    expect(seen).toEqual(['POST publish/start {}', 'GET publish', 'POST test/stop {} keepalive', 'POST publish/shot {"n":3,"name":"5-before","png":"iVBOR"}', 'POST publish/keep {"n":3}'])
    const refused = new HttpPublishBackend(async () => res(409, { ok: false, error: 'Publish first: Test in game plays the map Publish builds (before you keep it).' }))
    await expect(refused.testStart()).rejects.toMatchObject({ missing: false, status: 409, message: 'Publish first: Test in game plays the map Publish builds (before you keep it).' })
  })
})

describe('Test in game', () => {
  function testHost(blocked = false) {
    const states: string[] = []
    const said: string[] = []
    const win = { closed: false, location: { href: 'about:blank' }, close() { this.closed = true } } as GameWindow & { closed: boolean }
    let opened = 0
    return {
      win, states, said, opened: () => opened,
      host: { openWindow: () => (opened++, blocked ? null : win), say: (t: string) => said.push(t), onState: (v: TestInGameView) => states.push(v.state) },
    }
  }

  it('opens the tab first, turns it into the game when ready, and stops the server', async () => {
    const b = new FakeBackend()
    b.tests = [{ phase: 'starting', sentence: 'Starting.' }, { phase: 'starting', sentence: 'Starting.' }, { phase: 'running', url: 'http://127.0.0.1:5481/', sentence: 'Running.' }]
    const h = testHost()
    const t = new TestInGame(b, h.host, noSleep)
    const p = t.start(async () => true)
    expect(h.opened()).toBe(1) // inside the click, before any await
    await p
    expect(h.win.location.href).toBe('http://127.0.0.1:5481/')
    expect(h.states).toEqual(['building', 'starting', 'starting', 'ready'])
    expect(b.calls).toEqual(['testStart', 'test', 'test'])
    expect(t.active).toBe(true)
    await t.stop()
    expect(b.calls.at(-1)).toBe('testStop')
    expect(t.active).toBe(false)
    expect(h.said.at(-1)).toContain('copy of the database are gone')
  })

  it('says where the game is when the browser blocks the tab, and stops when the publish fails', async () => {
    const b = new FakeBackend()
    b.tests = [{ phase: 'running', url: 'http://127.0.0.1:5482/', sentence: 'Running.' }]
    const h = testHost(true)
    await new TestInGame(b, h.host, noSleep).start()
    expect(h.said.at(-1)).toContain('http://127.0.0.1:5482/')
    const b2 = new FakeBackend()
    const h2 = testHost()
    const t2 = new TestInGame(b2, h2.host, noSleep)
    await t2.start(async () => false)
    expect(b2.calls).toEqual([])
    expect(h2.win.closed).toBe(true)
    expect(t2.state.state).toBe('idle')
  })

  it('reports a test server that fails, and the API\'s refusal', async () => {
    const b = new FakeBackend()
    b.tests = [{ phase: 'failed', sentence: 'x', error: 'the port 7000 range is busy' }]
    const h = testHost()
    const t = new TestInGame(b, h.host, noSleep)
    await t.start()
    expect(t.state).toEqual({ state: 'failed', message: 'the port 7000 range is busy' })
    expect(h.said.at(-1)).toBe('Test in game could not start: the port 7000 range is busy')
    expect(h.win.location.href).toBe('about:blank')
    const b2 = new FakeBackend()
    b2.fail = new PublishApiError(404, NO_PUBLISH, true)
    const h2 = testHost()
    await new TestInGame(b2, h2.host, noSleep).start()
    expect(h2.said.at(-1)).toContain('Test in game is not in this editor yet')
  })
})
