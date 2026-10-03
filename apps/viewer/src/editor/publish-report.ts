/**
 * The Publish report in plain English (docs/WORLD_EDITOR.md §6.2 step 5, §6.4, §5 "Words, not codes", D34, D41;
 * docs/WAVE_PLAN8.md §6.0 step 2, lane WE-U): what the user changed, what closed for walking and why, the ten checks
 * with green / amber / red and a way out for each amber or red row, the budgets of the touched regions, the tests,
 * and the before / after pairs. DOM-free: the panel (./publish-panel.ts) draws this model, the tests read it.
 *
 * The run (`PublishRunView`) is the editor API's publish record (lane WE-A, `editor-api/protocol.ts` step 2) as the
 * page reads it (./publish.ts `runOf`); the checks are WE-N's `WorldEditsReport` exactly as `runPublishChecks` returns it.
 */
import type { CheckStatus, PublishCheck, WorldEditsReport } from '../../../../packages/convert/src/world/edits/checks.ts'
import { WE_EDITOR_UID_MAX, WE_EDITOR_UID_MIN } from '../../../../packages/shared/src/world-edits/index.ts'

// ---- the run (the API's side of Publish, read by the page) -----------------------------------------------------------

export type PublishState = 'idle' | 'running' | 'ready' | 'stopped' | 'failed' | 'kept' | 'discarded' | 'undone'
export type StepState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'

export interface PublishStep {
  key: string
  /** Plain English: "Checking the layers", "Re-building 4 regions", "Rebuilding walking"... */
  label: string
  state: StepState
  ms?: number
  note?: string
}

/** One before / after view of the sheet (§6.2 step 7): URLs an <img> shows. */
export interface PublishSheetPair {
  label: string
  before: string
  after: string
}

export interface PublishRunView {
  /** publish-<n> */
  id: number
  state: PublishState
  /** The API's job while state is 'running' (prepare, keep, discard, undo). */
  job?: string
  /** Another build holds the convert lock: the publish waits for it (its owner line). */
  waiting?: string
  steps?: PublishStep[]
  /** Region ids (z << 8 | x) the publish re-built. */
  regions?: number[]
  /** The changes in words since the last kept publish (the API's list). */
  changes?: string[]
  /** The API's banner sentence. */
  sentence?: string
  report?: WorldEditsReport | null
  sheet?: PublishSheetPair[]
  /** The tests' sentence. */
  tests?: string
  /** Painted tiles that get their upscaled maps at Keep. */
  hero?: string[]
  /** Files that differ from the live export with no edit there (a stale export). */
  drift?: number
  /** A failed step's sentence. */
  error?: string
  /** The git commit Keep made of the edits. */
  commit?: string
}

/** "Test in game" (§2.4): a private game server on a DB copy + a private game Vite on the staging export. */
export interface TestInGameView {
  state: 'idle' | 'building' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'
  /** The game's URL once ready. */
  url?: string
  /** A plain sentence from the API (what it is doing, or what failed). */
  message?: string
}

/** A view of the before / after sheet (the API's `PublishView`: a change's camera, position xyz + target xyz). */
export interface SheetView {
  id: number
  label: string
  view: number[]
  starred?: boolean
}

// ---- names ---------------------------------------------------------------------------------------------------------------

/** A place of the manifest (glTF metres), for "near Hill of Ye Mt". */
export interface NamedPlace {
  name: string
  x: number
  z: number
}

/** Text for innerHTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const SMALL = new Set(['of', 'the', 'and', 'in', 'at', 'to'])

/** 'hill-of-ye-mt' -> 'Hill of Ye Mt'. */
export function placeTitle(slug: string): string {
  return slug.split(/[-_]+/).filter(Boolean).map((w, i) => (i > 0 && SMALL.has(w) ? w : w[0]!.toUpperCase() + w.slice(1))).join(' ')
}

/** The names of regions: "171,97", or "171,97 (Hill of Ye Mt)" when a place is within 600 m of the region's centre. */
export class RegionNames {
  constructor(
    private readonly places: readonly NamedPlace[] = [],
    /** A region's centre in glTF metres (null: not in the export). */
    private readonly centre: (id: number) => { x: number; z: number } | null = () => null,
  ) {}

  /** '171_97' or '171,97' -> the id. */
  static parse(name: string): number | null {
    const m = /^(\d{1,3})[_,](\d{1,3})$/.exec(name.trim())
    if (!m) return null
    return (Number(m[2]) << 8) | Number(m[1])
  }

  place(id: number): string | null {
    const c = this.centre(id)
    if (!c || !this.places.length) return null
    let best: NamedPlace | null = null
    let bd = 600
    for (const p of this.places) {
      const d = Math.hypot(p.x - c.x, p.z - c.z)
      if (d < bd) {
        bd = d
        best = p
      }
    }
    return best ? placeTitle(best.name) : null
  }

  label(id: number): string {
    const p = this.place(id)
    return `${id & 0xff},${id >> 8}${p ? ` (${p})` : ''}`
  }

  /** A report's '171_97' -> '171,97 (Hill of Ye Mt)'. */
  labelOf(name: string): string {
    const id = RegionNames.parse(name)
    return id === null ? name : this.label(id)
  }
}

// ---- the model ---------------------------------------------------------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'bad' | 'busy' | 'muted'

export interface CheckRowView {
  id: number
  title: string
  status: CheckStatus
  tone: Tone
  summary: string
  /** The way out (amber / red rows only). */
  advice?: string
  /** The objects, points or regions behind the row, one sentence each (at most 8, then "and N more"). */
  items: string[]
  /** Per item: the object the editor can select for it ("Show"), or null. */
  refs: Array<string | null>
}

export interface ReportModel {
  tone: Tone
  headline: string
  detail: string
  steps: PublishStep[]
  /** The changes in words, newest last. */
  changes: string[]
  /** "What closed for walking, and why". */
  closed: string[]
  checks: CheckRowView[]
  budgets: string[]
  /** Hero textures at Keep, a stale export. */
  notes: string[]
  tests: string | null
  sheet: PublishSheetPair[]
  /** What the buttons may do now; a disabled button's tooltip says why. */
  keep: { enabled: boolean; why: string }
  goBack: boolean
  /** "Undo this publish" (a kept one). */
  undo: boolean
  testInGame: { enabled: boolean; why: string }
}

/** A change as the report needs it (the History's Change satisfies it). */
export interface ChangeLike {
  id: number
  label: string
  state: string
  regions: readonly number[]
}

const TILE_M2 = 4
const n = (v: number) => v.toLocaleString('en-US')
const plural = (k: number, one: string, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`
const MAX_ITEMS = 8

export const toneOf = (s: CheckStatus): Tone => (s === 'pass' ? 'ok' : s === 'warn' ? 'warn' : s === 'stop' ? 'bad' : 'muted')

/** The way out of an amber or red row (§5: every error is a sentence with a way out). */
export function adviceFor(key: PublishCheck['key'], status: CheckStatus): string | undefined {
  if (status !== 'warn' && status !== 'stop') return undefined
  switch (key) {
    case 'layers': return 'Undo or revert the change it names, then publish again. If it names a file, ask Claude to look at it.'
    case 'traps': return 'Undo the last change in that area, or smooth a slope so players can climb back out.'
    case 'reachable': return 'Undo or revert the last change near it, or open a path to it (smooth the slope, or move what blocks it).'
    case 'roads': return 'Open the road again: smooth the cliff across it, or move the object that blocks it.'
    case 'cutOff': return 'Smooth a way up to that ground so players can reach it, or leave it: nobody can enter it, and nothing breaks.'
    case 'props': return status === 'stop'
      ? 'Move the building back onto flat ground (Move, then G), or undo the ground change under it.'
      : 'Select each one and press G to put it on the ground, move it, or delete it.'
    case 'overlaps': return 'Move one of them a little so their walking footprints no longer overlap.'
    case 'budgets': return status === 'stop'
      ? 'Delete or move some objects in that region: past the hard line the game would slow down for everyone.'
      : 'It can go in, but this region is getting heavy: delete or move a few objects if you can.'
    case 'bounds': return 'Keep the edit inside the playable map, and paint on the shore instead of raising the sea floor.'
    case 'tests': return 'A test failed: nothing changed on the map. Ask Claude "is my map edit OK?": it reads the same report.'
  }
  return undefined
}

function capped(lines: string[]): string[] {
  return lines.length <= MAX_ITEMS ? lines : [...lines.slice(0, MAX_ITEMS), `… and ${n(lines.length - MAX_ITEMS)} more`]
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.map(rec) : [])
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

const KIND_WORDS: Record<string, string> = { nest: 'the monster nest', npc: 'the NPC', place: 'the place', gate: 'the gate', probe: 'the check point' }

/** The editor's object ref of a report key '166_95:34818' (a retail or dressing uid; editor adds have none here). */
export function refOfKey(key: string): string | null {
  const [r, u] = key.split(':')
  const region = RegionNames.parse(r ?? '')
  const uid = Number(u)
  if (region === null || !Number.isInteger(uid) || uid < 0 || (uid >= WE_EDITOR_UID_MIN && uid <= WE_EDITOR_UID_MAX)) return null
  return `r:${region}:${uid}`
}

/** Per item of `checkItems`: the object to select for it, or null. */
export function checkRefs(c: PublishCheck): Array<string | null> {
  const d = rec(c.details)
  const keys = c.key === 'props' ? arr(d.props).map(p => str(p.key)) : c.key === 'overlaps' ? arr(d.overlaps).map(o => str(o.a)) : []
  const refs = keys.map(refOfKey)
  return refs.length <= MAX_ITEMS ? refs : [...refs.slice(0, MAX_ITEMS), null]
}

/** One sentence per object, point or region behind a check row (its `details`). */
export function checkItems(c: PublishCheck, names: RegionNames): string[] {
  const d = rec(c.details)
  const where = (k: string) => `region ${names.labelOf(k.split(':')[0] ?? '')}`
  const model = (m: unknown) => str(m).replace(/\.(bsr|cpd)$/i, '') || 'An object'
  switch (c.key) {
    case 'layers': return capped([
      ...(Array.isArray(d.validators) ? d.validators : []).map(v => (typeof v === 'string' ? v : str(rec(v).message ?? rec(v).problem ?? JSON.stringify(v)))),
      ...(Array.isArray(d.navProblems) ? d.navProblems : []).map(p => `The walking rebuild refused: ${str(p)}`),
    ].filter(Boolean))
    case 'reachable': return capped(arr(d.lost).map(l => `${KIND_WORDS[str(l.kind)] ?? str(l.kind)} ${str(l.name) || str(l.id)} at ${Math.round(num(l.x))}, ${Math.round(num(l.z))} can't be reached from town any more`))
    case 'roads': return capped(arr(d.broken).map(b => {
      const what = `${KIND_WORDS[str(b.kind)] ?? str(b.kind)} ${str(b.name) || str(b.id)}`
      return !b.to && !b.from ? `${what}: no way there from the spawn, and no way back` : !b.to ? `${what}: no way there from the spawn` : `${what}: no way back to the spawn`
    }))
    case 'cutOff': return capped(arr(d.cut).map(x => {
      const t = Array.isArray(x.tiles) ? x.tiles.length : 0
      return `Region ${names.labelOf(str(x.region))}: ${plural(t, 'tile')} (${n(t * TILE_M2)} m²) nobody can walk onto`
    }))
    case 'props': return capped(arr(d.props).map(p => {
      const who = `${model(p.model)} in ${where(str(p.key))}`
      const change = num(p.clearanceChangeM)
      const what = p.verdict === 'buried'
        ? change < -0.5 ? `is ${Math.abs(change).toFixed(1)} m under the new ground` : `has the ground ${num(p.footprintMovedM).toFixed(1)} m higher around it`
        : `floats ${change.toFixed(1)} m above the new ground`
      return `${who} ${what}${p.building ? ': a building that blocks walking' : ''}`
    }))
    case 'overlaps': return capped(arr(d.overlaps).map(o => `Two walking footprints in ${where(str(o.a))} overlap by ${num(o.overlapM2).toFixed(1)} m²`))
    case 'budgets': return capped(arr(d.regions).filter(r => r.status !== 'pass').map(r => budgetLine(r, names)))
    default: return []
  }
}

const LEVEL_WORDS: Record<string, string> = { pass: 'inside the lines', warn: 'over the warning line', stop: 'past the hard line' }

function budgetLine(r: Record<string, unknown>, names: RegionNames): string {
  const b = rec(r.before)
  const a = rec(r.after)
  const parts: string[] = []
  const pair = (k: string, what: string) => {
    if (num(a[k]) !== num(b[k])) parts.push(`${what} ${n(num(b[k]))} → ${n(num(a[k]))}`)
  }
  pair('objectTriangles', 'object triangles')
  pair('placements', 'objects')
  pair('models', 'different models')
  pair('separateDraws', 'separate draws')
  const bench = r.benchNeeded ? ' (grew enough to need the speed check)' : ''
  return `Region ${names.labelOf(str(r.region))}: ${parts.join(', ') || 'unchanged counts'}, ${LEVEL_WORDS[str(r.status)] ?? str(r.status)}${bench}`
}

/** "What closed for walking, and why" from the nav step's per-region counts and the cut-off check. */
export function closedLines(report: WorldEditsReport, names: RegionNames): string[] {
  const out: string[] = []
  for (const r of report.nav.regions) {
    const parts: string[] = []
    if (r.closedSlope) parts.push(`${plural(r.closedSlope, 'tile')} (${n(r.closedSlope * TILE_M2)} m²) closed because the new slopes are steeper than 35°: players walk around them`)
    if (r.closedWater) parts.push(`${plural(r.closedWater, 'tile')} closed under new water deeper than 1.2 m`)
    if (r.forcedClosed) parts.push(`${plural(r.forcedClosed, 'tile')} you closed by hand`)
    if (r.forcedOpen || r.opened) parts.push(`${plural(Math.max(r.forcedOpen, r.opened), 'tile')} you opened by hand`)
    const o = r.objects
    const moved = o.replaced
    if (moved) parts.push(`${plural(moved, 'walking footprint')} moved with ${moved === 1 ? 'its object' : 'their objects'}`)
    if (o.added) parts.push(`${plural(o.added, 'new object')} now ${o.added === 1 ? 'blocks' : 'block'} walking where ${o.added === 1 ? 'it stands' : 'they stand'}`)
    if (o.removed) parts.push(`${plural(o.removed, 'deleted object')} no longer ${o.removed === 1 ? 'blocks' : 'block'} walking`)
    if (!parts.length) continue
    out.push(`Region ${names.labelOf(r.name)}: ${parts.join('; ')}.`)
  }
  for (const p of report.nav.problems) out.push(`The walking rebuild refused an edit: ${p}`)
  const cut = report.checks.find(c => c.key === 'cutOff')
  const cm2 = num(rec(cut?.details).cutOffM2)
  if (cut?.status === 'warn' && cm2) out.push(`${n(cm2)} m² of open ground can't be reached from town any more (see "Ground cut off").`)
  const traps = report.checks.find(c => c.key === 'traps')
  if (traps?.status === 'stop') out.push(traps.summary)
  if (!out.length) out.push(report.nav.totals.touched ? `Walking checked on ${plural(report.nav.totals.touched, 'tile')} of changed ground: nothing closed.` : 'No walking changed: your edits keep every path as it was.')
  return out
}

/** Repeated lines in a row become one with a count: "Raised the ground in 166,95 (×5)". */
export function mergeRepeats(lines: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length;) {
    let j = i + 1
    while (j < lines.length && lines[j] === lines[i]) j++
    out.push(j - i > 1 ? `${lines[i]} (×${j - i})` : lines[i]!)
    i = j
  }
  return out
}

/** The done changes, in words (the newest last), at most `max` (then "and N more"). */
export function changeLines(changes: readonly ChangeLike[], names: RegionNames, max = 12): string[] {
  const done = changes.filter(c => c.state === 'done')
  if (!done.length) return []
  const lines = mergeRepeats(done.map(c => {
    const place = c.regions.length ? names.place(c.regions[0]!) : null
    return place && !c.label.includes(place) ? `${c.label}, near ${place}` : c.label
  }))
  return lines.length <= max ? lines : [`… ${plural(lines.length - max, 'earlier change')}`, ...lines.slice(-max)]
}

const JOB_WORDS: Record<string, string> = { keep: 'Keeping', discard: 'Going back', undo: 'Undoing this publish' }

/** The whole report as the panel shows it. `changes`: the page's journal, when the API listed none. */
export function reportModel(run: PublishRunView, changes: readonly ChangeLike[], names: RegionNames): ReportModel {
  const report = run.report ?? null
  const steps = run.steps ?? []
  const checks: CheckRowView[] = (report?.checks ?? []).map(c => ({
    id: c.id, title: c.title, status: c.status, tone: toneOf(c.status), summary: c.summary,
    ...(adviceFor(c.key, c.status) ? { advice: adviceFor(c.key, c.status)! } : {}),
    items: checkItems(c, names),
    refs: checkRefs(c),
  }))
  const firstStop = report?.checks.find(c => c.status === 'stop')
  const busyStep = steps.find(s => s.state === 'running')
  const stepNo = busyStep ? steps.indexOf(busyStep) + 1 : steps.filter(s => s.state === 'done').length
  let tone: Tone
  let headline: string
  let detail: string
  switch (run.state) {
    case 'running': {
      tone = 'busy'
      const verb = JOB_WORDS[run.job ?? ''] ?? 'Publishing'
      headline = busyStep ? `${verb}… ${busyStep.label} (step ${stepNo} of ${steps.length})` : `${verb}…`
      detail = run.waiting
        ? `Waiting for another build to finish first (${run.waiting}). Nothing changes on the map until you press Keep.`
        : run.job === 'keep' ? 'Putting the new files in place and saving your edits in git.' : 'The map on this PC does not change until you press Keep. You can keep looking around meanwhile.'
      break
    }
    case 'ready':
      if (report?.verdict === 'warn') {
        tone = 'warn'
        headline = 'It can go in, but look at the amber rows first.'
      } else {
        tone = 'ok'
        headline = 'Everything checks out.'
      }
      detail = 'Keep makes this the map on this PC (the friends see it after a Deploy). Test in game lets you walk it first; Go back throws this build away and keeps your edits.'
      break
    case 'stopped':
      tone = 'bad'
      headline = `Publish stopped: ${firstStop?.summary ?? run.error ?? run.sentence ?? 'a check failed.'}`
      detail = 'Nothing changed on the map. Fix what the red rows say and publish again; your edits are all still here.'
      break
    case 'failed':
      tone = 'bad'
      headline = `Publish could not finish: ${run.error ?? run.sentence ?? 'a step failed.'}`
      detail = 'Nothing changed on the map: the export on this PC stays as it was. Your edits are all still here; try again, or ask Claude.'
      break
    case 'kept':
      tone = 'ok'
      headline = 'Kept: this is now the map on this PC.'
      detail = `Restart the local game server to play it here.${run.commit ? ` Your edits are saved in git (${run.commit}).` : ''} Deploy sends it to the friends' server when you want; "Undo this publish" puts the old files back.`
      break
    case 'discarded':
      tone = 'muted'
      headline = 'Gone back: the test build is thrown away.'
      detail = 'The map on this PC is as it was, and your edits are all still here.'
      break
    case 'undone':
      tone = 'muted'
      headline = 'This publish is undone.'
      detail = 'The map on this PC is back to how it was before it, and your edits are all still here.'
      break
    default:
      tone = 'muted'
      headline = 'No Publish yet.'
      detail = 'Publish checks your changes, re-builds the regions you touched and rebuilds walking. Nothing changes until you press Keep.'
  }
  const budgetsRow = report?.checks.find(c => c.key === 'budgets')
  const budgets = arr(rec(budgetsRow?.details).regions).map(r => budgetLine(r, names))
  const slots = rec(rec(rec(budgetsRow?.details).world).treeSlots)
  if (num(slots.after) !== num(slots.before)) budgets.push(`Trees world-wide: ${n(num(slots.before))} → ${n(num(slots.after))} (the line is 7,500)`)
  const testsRow = report?.checks.find(c => c.key === 'tests')
  const notes: string[] = []
  if (run.hero?.length) notes.push(`Keep turns on the upscaled maps of ${plural(run.hero.length, 'ground texture')} you painted widely (${run.hero.slice(0, 4).join(', ')}${run.hero.length > 4 ? ', …' : ''}).`)
  if (run.drift) notes.push(`${plural(run.drift, 'file')} of the map on this PC ${run.drift === 1 ? 'differs' : 'differ'} from a fresh build where you changed nothing (an older export). Publish leaves ${run.drift === 1 ? 'it' : 'them'} alone; the next full build refreshes ${run.drift === 1 ? 'it' : 'them'}.`)
  const ready = run.state === 'ready'
  const keep = !ready
    ? { enabled: false, why: run.state === 'running' ? 'Wait for the checks to finish.' : run.state === 'kept' ? 'Already kept.' : 'There is nothing to keep: this Publish did not finish.' }
    : !report
      ? { enabled: false, why: 'The checks did not report back.' }
      : report.verdict === 'stop'
        ? { enabled: false, why: 'A red row stops the Publish.' }
        : !report.complete
          ? { enabled: false, why: 'Some checks did not run (grey rows): Publish keeps only a complete report.' }
          : { enabled: true, why: 'Make this the map on this PC and save the edits in git.' }
  const testInGame = ready || run.state === 'stopped'
    ? { enabled: true, why: ready ? 'Play this map in the real game on a private test server (your account, a copy of the database).' : 'Walk the stopped build in the real game to see what the red rows mean (a private test server).' }
    : { enabled: false, why: run.state === 'running' ? 'Wait for the build to finish.' : run.state === 'kept' ? 'Kept: restart the local game server to play it.' : 'Test in game needs a finished build: publish again.' }
  return {
    tone, headline, detail, steps,
    changes: run.changes?.length ? mergeRepeats(run.changes) : changeLines(changes, names),
    closed: report ? closedLines(report, names) : [],
    checks, budgets, notes,
    tests: run.tests ?? (testsRow ? testsRow.summary : null),
    sheet: run.sheet ?? [],
    keep,
    goBack: ready || run.state === 'stopped',
    undo: run.state === 'kept',
    testInGame,
  }
}

/** The page's own views for the before / after pictures (its journal's cameras): starred first, then the newest, 30 m apart, at most `max`. */
export function sheetViews(changes: ReadonlyArray<ChangeLike & { view?: readonly number[]; starred?: boolean }>, max = 8): SheetView[] {
  const out: SheetView[] = []
  const done = changes.filter(c => c.state === 'done' && Array.isArray(c.view) && c.view.length === 6 && c.view.every(Number.isFinite))
  for (const c of [...done.filter(c => c.starred).reverse(), ...done.filter(c => !c.starred).reverse()]) {
    const v = c.view!
    if (out.some(o => Math.hypot(o.view[3]! - v[3]!, o.view[5]! - v[5]!) < 30)) continue
    out.push({ id: c.id, label: c.label, view: [...v], ...(c.starred ? { starred: true } : {}) })
    if (out.length >= max) break
  }
  return out
}
