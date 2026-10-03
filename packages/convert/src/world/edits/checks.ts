/**
 * The Publish checks and their report (lane WE-N; docs/WORLD_EDITOR.md §6.3 "The checks", §6.4, §7.2, D41, D42, D43).
 * Node-free and pure: the editor API's Publish (WE-A) feeds it the live and the staging export, the editor's worker
 * can run it on the walk preview's data (./nav-edit.ts `navEditData`), and `pnpm sro world-edit publish` reads the
 * same JSON ("is my map edit OK?").
 *
 * The ten rows (pass / warn / stop; `skip` = not run here):
 *   1 layers valid        external (the validators, §6.2 step 1) + the nav step's problems (an edit it refused)  stop
 *   2 nobody trapped      components the town reaches but can't leave: count and area must not grow            stop
 *   3 still reachable     every nest, NPC, place, gate and probe that was in the town's component still is      stop
 *   4 gates and roads     spawn <-> each gate, place and probe, both ways (componentReaches), as before         stop
 *   5 ground cut off      edited open tiles that reached town before and don't now (area; "close it")          warn
 *   6 props on moved      clearance change at the origin / footprint: buried (> 0.5 m, footprint > 1 m) or
 *     ground              floating (> 0.3 m); a building with a nav footprint stops                               warn / stop
 *   7 overlaps            a moved / added nav footprint over another's (box overlap > 1 m²)                      warn
 *   8 budgets             per touched region (§7.2 lines, counted before the tree swap) + the bench trigger      warn / stop
 *   9 coast and bounds    external (§7.3)                                                                        stop
 *  10 tests               external (§6.2 step 6)                                                                 stop
 *
 * Swimming (wave 13, docs/SWIMMING.md §2.5): checks 2-4 will run on the **player** graph (swim tiles traversable) and
 * nests on the **monsters'** graph; both come from `reachWorlds` below, the one place that builds the graphs (today
 * both are the walking graph). The report already carries the deep-water tiles (`swim`).
 *
 * Positions of points are glTF metres of the export frame; the nav is world file space (dm).
 */
import { NVM_REGION_SIZE } from '@sro/formats'
import { NavGltf, NavWorld, type NavData, type NavInstance } from '@sro/nav'
import { WE_GUARDRAILS, WE_EDITOR_UID_MIN, WE_EDITOR_UID_MAX } from '../../../../shared/src/world-edits/index.ts'
import type { NavEditRegionStats, NavEditReport } from './nav-edit.ts'

export const WORLD_EDITS_REPORT_FORMAT = 'sro-world-edits-report'
export const WORLD_EDITS_REPORT_VERSION = 1

export type CheckStatus = 'pass' | 'warn' | 'stop' | 'skip'
export type CheckKey = 'layers' | 'traps' | 'reachable' | 'roads' | 'cutOff' | 'props' | 'overlaps' | 'budgets' | 'bounds' | 'tests'

/** Row order and titles (docs/WORLD_EDITOR.md §6.3). */
export const PUBLISH_CHECKS: ReadonlyArray<{ id: number; key: CheckKey; title: string }> = [
  { id: 1, key: 'layers', title: 'Layers valid' },
  { id: 2, key: 'traps', title: 'Nobody trapped' },
  { id: 3, key: 'reachable', title: 'Everything that was reachable still is' },
  { id: 4, key: 'roads', title: 'Gates and roads connected' },
  { id: 5, key: 'cutOff', title: 'Ground cut off' },
  { id: 6, key: 'props', title: 'Props on moved ground' },
  { id: 7, key: 'overlaps', title: 'Overlaps' },
  { id: 8, key: 'budgets', title: 'Budgets' },
  { id: 9, key: 'bounds', title: 'Coast and bounds' },
  { id: 10, key: 'tests', title: 'Tests' },
]

export interface PublishCheck {
  id: number
  key: CheckKey
  title: string
  status: CheckStatus
  /** One plain sentence for the report page. */
  summary: string
  details?: unknown
}

/** A check run elsewhere (the validators, the coast and bounds rules, the tests, the Publish bench). */
export interface ExternalCheck {
  status: CheckStatus
  summary: string
  details?: unknown
}

/** A point that must stay reachable (glTF metres). `y` absent: the highest surface at (x, z). */
export interface CheckPoint {
  kind: 'nest' | 'npc' | 'place' | 'gate' | 'probe'
  id: string
  name?: string
  x: number
  z: number
  y?: number
}

/** What the props and budget checks read of a placement (structurally the manifest's WorldPlacement). */
export interface CheckPlacement {
  region: number
  uid: number
  objId: number
  source: string
  models: number[]
  position: [number, number, number]
}

/** What they read of a model (structurally the manifest's WorldModel). */
export interface CheckModel {
  kind: string
  boundsMin: [number, number, number]
  boundsMax: [number, number, number]
  treeSwap?: unknown
}

export interface CheckScene {
  placements: readonly CheckPlacement[]
  models: readonly CheckModel[]
}

export interface PublishCheckInput {
  world: string
  /** manifest.space.originRegion */
  origin: { x: number; z: number }
  /** manifest.spawn (glTF metres). */
  spawn: { x: number; y: number; z: number }
  /** nav.bin of the live export (before) and of the staging export (after). */
  before: NavData
  after: NavData
  /** The nav step's report (closed tiles, deep water, refused edits). */
  nav?: NavEditReport | null
  points?: readonly CheckPoint[]
  /** The manifests' placements and models (checks 6 and 8); without them both are skipped. */
  scene?: { before: CheckScene; after: CheckScene } | null
  /** Moves that changed a placement's key (`lowerPlacementEdits` assigned): old `region:uid` -> new. */
  moved?: ReadonlyMap<string, string>
  /** LOD0 triangles of a model (scene index), for the budgets; default 0 (the triangle lines then never fire). */
  triangles?(which: 'before' | 'after', model: number): number
  /** lights.json and zones.json after the edit (budget rows "light points within 60 m" and "zones per point"). */
  lights?: ReadonlyArray<{ x: number; z: number }>
  zones?: ReadonlyArray<{ shape: { circle: { x: number; z: number; r: number } } | { poly: Array<[number, number]> } }>
  /** Checks 1, 9, 10 and the Publish bench (folded into 8). */
  external?: Partial<Record<'layers' | 'bounds' | 'tests' | 'bench', ExternalCheck>>
}

export interface WorldEditsReport {
  format: typeof WORLD_EDITS_REPORT_FORMAT
  version: typeof WORLD_EDITS_REPORT_VERSION
  world: string
  /** stop if any row stops, else warn if any warns, else pass. */
  verdict: 'pass' | 'warn' | 'stop'
  /** Every row ran (none is `skip`). Publish keeps only a complete report without a stop. */
  complete: boolean
  checks: PublishCheck[]
  nav: {
    regions: Array<Omit<NavEditRegionStats, 'closedTiles' | 'openedTiles' | 'deepWater'> & { name: string; closedTiles: number[]; openedTiles: number[] }>
    totals: { touched: number; closed: number; opened: number; closedSlope: number; closedWater: number; objects: number }
    problems: string[]
  }
  /** The wave-13 hook: tiles under new water deeper than 1.2 m, closed for walking, swimmable once swimming lands. */
  swim: { deepWaterTiles: number; deepWaterM2: number; regions: Array<{ name: string; tiles: number[] }> }
  timingsMs: Record<string, number>
}

const TILE_M2 = 4
const TILES = 96
const U = 10 // file units per metre
const keyOf = (region: number, uid: number) => `${region}:${uid}`
const regionName = (id: number) => `${id & 0xff}_${(id >> 8) & 0xff}`
const round = (v: number, d = 1) => +v.toFixed(d)
const VEGETATION = /[\\/]nature[\\/]|tree|bush|grass|flower|reed|plant|tre_/i

/**
 * The reachability graphs the checks walk. Wave 12: both are the walking graph. Wave 13 (docs/SWIMMING.md §2.5 SW-D6):
 * `player` adds the swim layer (swim tiles traversable, the shore exit rule), `monster` keeps swim tiles closed.
 */
export function reachWorlds(data: NavData, origin: { x: number; z: number }): { player: NavGltf; monster: NavGltf } {
  const walk = new NavGltf(new NavWorld(data), origin)
  return { player: walk, monster: walk }
}

// --- report ---------------------------------------------------------------------------------------------------------

/** The report as written to `work/editor/<world>/publish-<n>/report.json` (stable key order, one space indent). */
export function encodeWorldEditsReport(r: WorldEditsReport): string {
  return JSON.stringify(r, null, 1) + '\n'
}

/** Parses a report; throws when it is not one. */
export function parseWorldEditsReport(text: string): WorldEditsReport {
  const r = JSON.parse(text) as Partial<WorldEditsReport>
  if (r.format !== WORLD_EDITS_REPORT_FORMAT || r.version !== WORLD_EDITS_REPORT_VERSION) {
    throw new Error(`world edits report: expected ${WORLD_EDITS_REPORT_FORMAT} v${WORLD_EDITS_REPORT_VERSION}`)
  }
  if (!Array.isArray(r.checks) || r.checks.length !== PUBLISH_CHECKS.length) throw new Error('world edits report: expected 10 checks')
  return r as WorldEditsReport
}

const row = (key: CheckKey, status: CheckStatus, summary: string, details?: unknown): PublishCheck => {
  const c = PUBLISH_CHECKS.find(k => k.key === key)!
  return { id: c.id, key, title: c.title, status, summary, ...(details !== undefined ? { details } : {}) }
}

const worst = (...s: CheckStatus[]): CheckStatus =>
  s.includes('stop') ? 'stop' : s.includes('warn') ? 'warn' : s.every(x => x === 'skip') ? 'skip' : 'pass'

// --- the run --------------------------------------------------------------------------------------------------------

/** Runs checks 2-8 on the two navs and scenes, folds in 1, 9, 10, and returns the report. */
export function runPublishChecks(input: PublishCheckInput): WorldEditsReport {
  const timingsMs: Record<string, number> = {}
  const time = <T>(label: string, f: () => T): T => {
    const t = performance.now()
    const v = f()
    timingsMs[label] = round(performance.now() - t, 0)
    return v
  }
  const B = time('navBefore', () => reachWorlds(input.before, input.origin))
  const A = time('navAfter', () => reachWorlds(input.after, input.origin))
  const homeB = time('reachBefore', () => homeOf(B.player, input.spawn))
  const homeA = time('reachAfter', () => homeOf(A.player, input.spawn))

  const checks: PublishCheck[] = []
  // 1
  const navProblems = input.nav?.problems ?? []
  const ext1 = input.external?.layers
  const s1 = navProblems.length ? 'stop' : ext1 ? ext1.status : 'skip'
  checks.push(row('layers', worst(s1, ext1?.status ?? 'skip'),
    navProblems.length ? `The walking rebuild refused ${navProblems.length} edit(s): ${navProblems[0]}` : ext1?.summary ?? 'Not run here (the layer validators run first).',
    { ...(ext1?.details !== undefined ? { validators: ext1.details } : {}), navProblems }))
  if (homeB < 0 || homeA < 0) {
    const s = homeA < 0 ? 'stop' : 'skip'
    const msg = homeA < 0 ? 'The town spawn is no longer on walkable ground.' : 'The live export has no walkable town spawn; nothing to compare.'
    for (const key of ['traps', 'reachable', 'roads', 'cutOff'] as const) checks.push(row(key, s, msg))
  } else {
    checks.push(time('traps', () => trapsCheck(B.player, homeB, A.player, homeA)))
    const pts = input.points ?? []
    checks.push(time('reachable', () => reachableCheck(B, A, input.spawn, pts)))
    checks.push(time('roads', () => roadsCheck(B.player, A.player, input.spawn, pts)))
    checks.push(time('cutOff', () => cutOffCheck(input.before, input.after, B.player, homeB, A.player, homeA)))
  }
  checks.push(time('props', () => propsCheck(input, B.player, A.player)))
  checks.push(time('overlaps', () => overlapsCheck(input.before, input.after)))
  checks.push(time('budgets', () => budgetsCheck(input)))
  const ext9 = input.external?.bounds
  checks.push(row('bounds', ext9?.status ?? 'skip', ext9?.summary ?? 'Not run here (the coast and bounds rules, §7.3).', ext9?.details))
  const ext10 = input.external?.tests
  checks.push(row('tests', ext10?.status ?? 'skip', ext10?.summary ?? 'Not run here (the world-edits tests, §6.2 step 6).', ext10?.details))

  const statuses = checks.map(c => c.status)
  const verdict = statuses.includes('stop') ? 'stop' : statuses.includes('warn') ? 'warn' : 'pass'
  return {
    format: WORLD_EDITS_REPORT_FORMAT, version: WORLD_EDITS_REPORT_VERSION, world: input.world,
    verdict, complete: !statuses.includes('skip'), checks, nav: navSection(input.nav), swim: swimSection(input.nav), timingsMs,
  }
}

function homeOf(g: NavGltf, spawn: { x: number; y: number; z: number }): number {
  const p = g.locate(spawn.x, spawn.z, spawn.y)
  return p ? g.componentOf(p) : -1
}

function navSection(nav: NavEditReport | null | undefined): WorldEditsReport['nav'] {
  const regions = (nav?.regions ?? []).map(({ deepWater: _d, ...s }) => ({ ...s, name: regionName(s.region) }))
  const sum = (f: (s: NavEditRegionStats) => number) => (nav?.regions ?? []).reduce((a, s) => a + f(s), 0)
  return {
    regions,
    totals: {
      touched: sum(s => s.touched), closed: sum(s => s.closed), opened: sum(s => s.opened), closedSlope: sum(s => s.closedSlope),
      closedWater: sum(s => s.closedWater), objects: sum(s => s.objects.removed + s.objects.replaced + s.objects.added),
    },
    problems: nav?.problems ?? [],
  }
}

function swimSection(nav: NavEditReport | null | undefined): WorldEditsReport['swim'] {
  const regions = (nav?.regions ?? []).filter(s => s.deepWater.length).map(s => ({ name: regionName(s.region), tiles: s.deepWater }))
  const n = regions.reduce((a, r) => a + r.tiles.length, 0)
  return { deepWaterTiles: n, deepWaterM2: n * TILE_M2, regions }
}

// --- 2: traps ---------------------------------------------------------------------------------------------------------

/** Components the town reaches but cannot leave (count, area m²). */
export function trapCensus(g: NavGltf, home: number): { count: number; areaM2: number } {
  let count = 0
  let area = 0
  for (const c of g.world.components()) {
    if (c.id === home) continue
    if (g.world.componentReaches(home, c.id) && !g.world.componentReaches(c.id, home)) {
      count++
      area += c.areaM2
    }
  }
  return { count, areaM2: round(area) }
}

function trapsCheck(gB: NavGltf, homeB: number, gA: NavGltf, homeA: number): PublishCheck {
  const b = trapCensus(gB, homeB)
  const a = trapCensus(gA, homeA)
  const grew = a.count > b.count || a.areaM2 > b.areaM2 + 0.5
  return row('traps', grew ? 'stop' : 'pass',
    grew
      ? `New traps: places the town reaches but can't leave went from ${b.count} (${b.areaM2} m²) to ${a.count} (${a.areaM2} m²).`
      : `No new traps (${a.count} as before, ${a.areaM2} m²).`,
    { before: b, after: a })
}

// --- 3, 4: reachability -------------------------------------------------------------------------------------------------

function locatePoint(g: NavGltf, p: { x: number; z: number; y?: number }) {
  return g.locate(p.x, p.z, p.y ?? Infinity)
}

function reachableCheck(
  B: { player: NavGltf; monster: NavGltf }, A: { player: NavGltf; monster: NavGltf }, spawn: { x: number; y: number; z: number }, points: readonly CheckPoint[],
): PublishCheck {
  const homes = new Map<NavGltf, number>()
  const home = (g: NavGltf) => homes.get(g) ?? homes.set(g, homeOf(g, spawn)).get(g)!
  const lost: Array<{ kind: string; id: string; name?: string; x: number; z: number }> = []
  let checked = 0
  for (const p of points) {
    // nests on the monsters' graph, everything else on the players' (the same graph until wave 13)
    const gB = p.kind === 'nest' ? B.monster : B.player
    const gA = p.kind === 'nest' ? A.monster : A.player
    const pb = locatePoint(gB, p)
    if (!pb || gB.componentOf(pb) !== home(gB)) continue
    checked++
    const pa = locatePoint(gA, p)
    if (pa && gA.componentOf(pa) === home(gA)) continue
    lost.push({ kind: p.kind, id: p.id, ...(p.name ? { name: p.name } : {}), x: round(p.x), z: round(p.z) })
  }
  return row('reachable', lost.length ? 'stop' : 'pass',
    lost.length
      ? `${lost.length} of ${checked} point(s) the town reached can't be reached now (${lost.slice(0, 3).map(l => `${l.kind} ${l.name ?? l.id}`).join(', ')}${lost.length > 3 ? ', ...' : ''}).`
      : `All ${checked} nests, NPCs, places, gates and probes the town reached still are.`,
    { checked, lost })
}

function roadsCheck(gB: NavGltf, gA: NavGltf, spawn: { x: number; y: number; z: number }, points: readonly CheckPoint[]): PublishCheck {
  const sB = gB.locate(spawn.x, spawn.z, spawn.y)
  const sA = gA.locate(spawn.x, spawn.z, spawn.y)
  const cB = sB ? gB.componentOf(sB) : -1
  const cA = sA ? gA.componentOf(sA) : -1
  const broken: Array<{ kind: string; id: string; name?: string; to: boolean; from: boolean }> = []
  let pairs = 0
  for (const p of points) {
    if (p.kind !== 'gate' && p.kind !== 'place' && p.kind !== 'probe') continue
    const pb = locatePoint(gB, p)
    if (!pb) continue
    const kb = gB.componentOf(pb)
    if (kb < 0 || !gB.world.componentReaches(cB, kb) || !gB.world.componentReaches(kb, cB)) continue
    pairs++
    const pa = locatePoint(gA, p)
    const ka = pa ? gA.componentOf(pa) : -1
    const to = ka >= 0 && gA.world.componentReaches(cA, ka)
    const from = ka >= 0 && gA.world.componentReaches(ka, cA)
    if (!to || !from) broken.push({ kind: p.kind, id: p.id, ...(p.name ? { name: p.name } : {}), to, from })
  }
  return row('roads', broken.length ? 'stop' : 'pass',
    broken.length
      ? `${broken.length} gate(s), place(s) or probe(s) lost their way to or from the spawn (${broken.slice(0, 3).map(b => b.name ?? b.id).join(', ')}).`
      : `The spawn and all ${pairs} gates, places and probes still reach each other both ways.`,
    { pairs, broken })
}

// --- 5: ground cut off ------------------------------------------------------------------------------------------------

/** Per region id: the tiles an edit touched (a corner moved > 5 cm, openness changed, or under a changed footprint). */
export function editedTiles(before: NavData, after: NavData): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>()
  const add = (region: number, t: number) => {
    let s = out.get(region)
    if (!s) out.set(region, (s = new Set()))
    s.add(t)
  }
  const byId = new Map(before.regions.map(r => [r.id, r]))
  const G = TILES + 1
  for (const a of after.regions) {
    const b = byId.get(a.id)
    if (!b || (a.heights === b.heights && a.tileCells === b.tileCells)) continue
    const isOpen = (r: typeof a, t: number) => r.tileCells[t]! >= 0 && r.tileCells[t]! < r.openCellCount
    for (let tz = 0; tz < TILES; tz++) {
      for (let tx = 0; tx < TILES; tx++) {
        const t = tz * TILES + tx
        const k = tz * G + tx
        const moved = [k, k + 1, k + G, k + G + 1].some(v => Math.abs(a.heights[v]! - b.heights[v]!) > 0.05 * U)
        if (moved || isOpen(a, t) !== isOpen(b, t)) add(a.id, t)
      }
    }
  }
  for (const box of changedInstanceBoxes(before, after)) {
    for (let fz = Math.floor(box.minZ / 20); fz <= Math.floor(box.maxZ / 20); fz++) {
      for (let fx = Math.floor(box.minX / 20); fx <= Math.floor(box.maxX / 20); fx++) {
        const rx = Math.floor(fx / TILES), rz = Math.floor(fz / TILES)
        add(((rz & 0xff) << 8) | (rx & 0xff), (fz - rz * TILES) * TILES + (fx - rx * TILES))
      }
    }
  }
  return out
}

function cutOffCheck(before: NavData, after: NavData, gB: NavGltf, homeB: number, gA: NavGltf, homeA: number): PublishCheck {
  const cut: Array<{ region: string; tiles: number[] }> = []
  let stillHome = 0
  let edited = 0
  for (const [region, tiles] of editedTiles(before, after)) {
    const rx = region & 0xff, rz = (region >> 8) & 0xff
    const lost: number[] = []
    for (const t of [...tiles].sort((x, y) => x - y)) {
      const x = rx * NVM_REGION_SIZE + (t % TILES) * 20 + 10
      const z = rz * NVM_REGION_SIZE + Math.floor(t / TILES) * 20 + 10
      if (!gA.world.terrainOpen(x, z)) continue
      edited++
      const pa = gA.world.locate(x, z, -Infinity)
      const ha = !!pa && pa.surface.kind === 'terrain' && gA.world.componentOf(pa) === homeA
      if (ha) {
        stillHome++
        continue
      }
      const pb = gB.world.locate(x, z, -Infinity)
      if (pb && pb.surface.kind === 'terrain' && gB.world.componentOf(pb) === homeB) lost.push(t)
    }
    if (lost.length) cut.push({ region: regionName(region), tiles: lost })
  }
  const n = cut.reduce((a, c) => a + c.tiles.length, 0)
  return row('cutOff', n ? 'warn' : 'pass',
    n ? `${n} open tile(s) (${n * TILE_M2} m²) of the edit can't be reached from town any more: an island nobody can enter. Close it, or open a way.`
      : `No ground cut off (${stillHome} of ${edited} edited open tiles still reach town).`,
    { editedOpenTiles: edited, stillReachable: stillHome, cutOffTiles: n, cutOffM2: n * TILE_M2, cut })
}

// --- 6: props on moved ground ----------------------------------------------------------------------------------------

function propsCheck(input: PublishCheckInput, gB: NavGltf, gA: NavGltf): PublishCheck {
  if (!input.scene) return row('props', 'skip', 'Not run (no placements given).')
  const ground = (g: NavGltf, x: number, z: number) => {
    const h = g.world.terrainHeight(g.fileX(x), g.fileZ(z))
    return Number.isNaN(h) ? null : h / U
  }
  const footprinted = new Set(input.after.instances.map(i => i.objId))
  const byKey = new Map(input.scene.before.placements.map(p => [keyOf(p.region, p.uid), p]))
  const from = new Map<string, string>()
  for (const [o, n] of input.moved ?? []) from.set(n, o)
  const rows: Array<Record<string, unknown>> = []
  let status: CheckStatus = 'pass'
  for (const p of input.scene.after.placements) {
    const key = keyOf(p.region, p.uid)
    const old = byKey.get(from.get(key) ?? key)
    if (!old) continue // an add: the editor snaps it; nothing to compare
    const moved = old.position[0] !== p.position[0] || old.position[1] !== p.position[1] || old.position[2] !== p.position[2]
    const gA0 = ground(gA, p.position[0], p.position[2])
    const gB0 = ground(gB, p.position[0], p.position[2])
    const gOld = ground(gB, old.position[0], old.position[2])
    if (gA0 === null || gB0 === null || gOld === null) continue
    const veg = VEGETATION.test(p.source)
    const model = input.scene.after.models[p.models[0] ?? -1]
    const half = veg || !model
      ? 1.5
      : Math.max(Math.abs(model.boundsMin[0]), Math.abs(model.boundsMax[0]), Math.abs(model.boundsMin[2]), Math.abs(model.boundsMax[2]))
    let fpRise = 0
    let fpMoved = 0
    for (const dx of [-half * 0.5, 0, half * 0.5]) {
      for (const dz of [-half * 0.5, 0, half * 0.5]) {
        const a = ground(gB, p.position[0] + dx, p.position[2] + dz)
        const b = ground(gA, p.position[0] + dx, p.position[2] + dz)
        if (a === null || b === null) continue
        fpRise = Math.max(fpRise, b - a)
        fpMoved = Math.max(fpMoved, Math.abs(b - a))
      }
    }
    const dOrigin = gA0 - gB0
    if (!moved && Math.abs(dOrigin) < 0.05 && fpMoved < 0.5) continue
    // retail origins often sit below the ground (sunk trunks): judge the change of the clearance (D21)
    const change = (p.position[1] - gA0) - (old.position[1] - gOld)
    const verdict = change < -0.5 || (!moved && fpRise > 1) ? 'buried' : change > 0.3 ? 'floating' : 'ok'
    if (verdict === 'ok') continue
    const building = !veg && footprinted.has(p.objId)
    status = worst(status, building ? 'stop' : 'warn')
    rows.push({
      key: `${regionName(p.region)}:${p.uid}`, model: p.source.split(/[\\/]/).pop(), moved, groundMovedM: round(dOrigin, 2),
      footprintMovedM: round(fpMoved, 2), clearanceChangeM: round(change, 2), verdict, ...(building ? { building: true } : {}),
    })
  }
  return row('props', status,
    rows.length ? `${rows.length} object(s) on moved ground look ${rows.some(r => r.verdict === 'buried') ? 'buried' : 'floating'}` +
      `${status === 'stop' ? ', a building with a walking footprint among them' : ''}.` : 'Every object on moved ground still stands on it.',
    { props: rows })
}

// --- 7: overlaps --------------------------------------------------------------------------------------------------------

interface Box { minX: number; minZ: number; maxX: number; maxZ: number }

function instanceBox(data: NavData, inst: NavInstance): Box {
  const v = data.models[inst.model]!.vertices
  const c = Math.cos(inst.yaw)
  const s = Math.sin(inst.yaw)
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  for (let i = 0; i < v.length; i += 3) {
    const x = inst.x + c * v[i]! - s * v[i + 2]!
    const z = inst.z + s * v[i]! + c * v[i + 2]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return { minX, minZ, maxX, maxZ }
}

const sameTransform = (a: NavInstance, b: NavInstance) => a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw && a.objId === b.objId

/** Boxes (world file space) of instances moved, added or removed between the two navs. */
function changedInstanceBoxes(before: NavData, after: NavData): Box[] {
  const b = new Map(before.instances.map(i => [i.id >>> 0, i]))
  const a = new Map(after.instances.map(i => [i.id >>> 0, i]))
  const out: Box[] = []
  for (const [id, inst] of a) {
    const old = b.get(id)
    if (old && sameTransform(old, inst)) continue
    out.push(instanceBox(after, inst))
    if (old) out.push(instanceBox(before, old))
  }
  for (const [id, inst] of b) if (!a.has(id)) out.push(instanceBox(before, inst))
  return out
}

function overlapsCheck(before: NavData, after: NavData): PublishCheck {
  const b = new Map(before.instances.map(i => [i.id >>> 0, i]))
  const changed = after.instances.filter(i => {
    const old = b.get(i.id >>> 0)
    return !old || !sameTransform(old, i)
  })
  if (!changed.length) return row('overlaps', 'pass', 'No walking footprint moved or was added.')
  const boxes = after.instances.map(i => instanceBox(after, i))
  const CELL = 640
  const grid = new Map<string, number[]>()
  boxes.forEach((bx, i) => {
    for (let gz = Math.floor(bx.minZ / CELL); gz <= Math.floor(bx.maxZ / CELL); gz++) {
      for (let gx = Math.floor(bx.minX / CELL); gx <= Math.floor(bx.maxX / CELL); gx++) {
        const k = `${gx},${gz}`
        const l = grid.get(k)
        if (l) l.push(i)
        else grid.set(k, [i])
      }
    }
  })
  const index = new Map(after.instances.map((inst, i) => [inst, i]))
  const seen = new Set<string>()
  const hits: Array<{ a: string; b: string; overlapM2: number }> = []
  for (const inst of changed) {
    const i = index.get(inst)!
    const bx = boxes[i]!
    for (let gz = Math.floor(bx.minZ / CELL); gz <= Math.floor(bx.maxZ / CELL); gz++) {
      for (let gx = Math.floor(bx.minX / CELL); gx <= Math.floor(bx.maxX / CELL); gx++) {
        for (const j of grid.get(`${gx},${gz}`) ?? []) {
          if (j === i) continue
          const pair = i < j ? `${i}:${j}` : `${j}:${i}`
          if (seen.has(pair)) continue
          seen.add(pair)
          const o = boxes[j]!
          const w = Math.min(bx.maxX, o.maxX) - Math.max(bx.minX, o.minX)
          const h = Math.min(bx.maxZ, o.maxZ) - Math.max(bx.minZ, o.minZ)
          if (w <= 0 || h <= 0) continue
          const m2 = (w * h) / (U * U)
          if (m2 <= 1) continue
          const name = (n: NavInstance) => `${regionName(n.id >>> 16)}:${n.id & 0xffff}`
          hits.push({ a: name(inst), b: name(after.instances[j]!), overlapM2: round(m2) })
        }
      }
    }
  }
  return row('overlaps', hits.length ? 'warn' : 'pass',
    hits.length ? `${hits.length} moved or added walking footprint(s) overlap another (largest ${Math.max(...hits.map(h => h.overlapM2))} m²).`
      : `${changed.length} moved or added walking footprint(s), none over another.`,
    { changed: changed.length, overlaps: hits })
}

// --- 8: budgets ---------------------------------------------------------------------------------------------------------

export interface RegionLoad {
  objectTriangles: number
  placements: number
  models: number
  /** Placements drawn outside the region batch: skinned models (lamps and cloth sway in the batch). */
  separateDraws: number
  /** Editor adds (uid 0xE000-0xEFFF). */
  editorAdds: number
}

/** The per-region load of a scene (owner region; the triangle lines count the carriers' retail LOD0, D42). */
export function regionLoads(scene: CheckScene, triangles: (model: number) => number): Map<number, RegionLoad> {
  const out = new Map<number, RegionLoad & { set: Set<number> }>()
  for (const p of scene.placements) {
    let r = out.get(p.region)
    if (!r) out.set(p.region, (r = { objectTriangles: 0, placements: 0, models: 0, separateDraws: 0, editorAdds: 0, set: new Set() }))
    r.placements++
    for (const m of p.models) {
      r.objectTriangles += triangles(m)
      r.set.add(m)
    }
    if (p.models.some(m => scene.models[m]?.kind === 'skinned')) r.separateDraws++
    if (p.uid >= WE_EDITOR_UID_MIN && p.uid <= WE_EDITOR_UID_MAX) r.editorAdds++
  }
  const res = new Map<number, RegionLoad>()
  for (const [id, { set, ...r }] of out) res.set(id, { ...r, models: set.size })
  return res
}

/** Swapped tree placements in a scene (the band texture's slots, world-wide). */
export const treeSlots = (scene: CheckScene) => scene.placements.reduce((n, p) => n + (scene.models[p.models[0] ?? -1]?.treeSwap ? 1 : 0), 0)

/** The most light points within 60 m of one of them (itself included). */
export function lightDensity(lights: ReadonlyArray<{ x: number; z: number }>): number {
  let best = 0
  for (const a of lights) {
    let n = 0
    for (const b of lights) if (Math.hypot(a.x - b.x, a.z - b.z) <= 60) n++
    best = Math.max(best, n)
  }
  return best
}

const inZone = (z: NonNullable<PublishCheckInput['zones']>[number], x: number, y: number): boolean => {
  if ('circle' in z.shape) return Math.hypot(x - z.shape.circle.x, y - z.shape.circle.z) <= z.shape.circle.r
  const poly = z.shape.poly
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!
    const [xj, zj] = poly[j]!
    if ((zi > y) !== (zj > y) && x < ((xj - xi) * (y - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** The most sound zones over one point (sampled at every zone's centre and vertices). */
export function zoneOverlap(zones: NonNullable<PublishCheckInput['zones']>): number {
  const samples: Array<[number, number]> = []
  for (const z of zones) {
    if ('circle' in z.shape) samples.push([z.shape.circle.x, z.shape.circle.z])
    else {
      const p = z.shape.poly
      samples.push(...p, [p.reduce((a, v) => a + v[0], 0) / p.length, p.reduce((a, v) => a + v[1], 0) / p.length])
    }
  }
  let best = 0
  for (const [x, y] of samples) best = Math.max(best, zones.filter(z => inZone(z, x, y)).length)
  return best
}

const lineStatus = (v: number, was: number, line: { warn: number; refuse: number }): CheckStatus =>
  v > was && v >= line.refuse ? 'stop' : v > was && v >= line.warn ? 'warn' : 'pass'

function budgetsCheck(input: PublishCheckInput): PublishCheck {
  const bench = input.external?.bench
  if (!input.scene) {
    return row('budgets', bench?.status ?? 'skip', bench?.summary ?? 'Not run (no placements given).', bench ? { bench: bench.details } : undefined)
  }
  const tri = input.triangles ?? (() => 0)
  const lb = regionLoads(input.scene.before, m => tri('before', m))
  const la = regionLoads(input.scene.after, m => tri('after', m))
  const G = WE_GUARDRAILS
  const regions: Array<Record<string, unknown>> = []
  let status: CheckStatus = 'pass'
  let benchNeeded = false
  const zero: RegionLoad = { objectTriangles: 0, placements: 0, models: 0, separateDraws: 0, editorAdds: 0 }
  for (const id of [...new Set([...lb.keys(), ...la.keys()])].sort((a, b) => a - b)) {
    const b = lb.get(id) ?? zero
    const a = la.get(id) ?? zero
    if (a.objectTriangles === b.objectTriangles && a.placements === b.placements && a.models === b.models && a.separateDraws === b.separateDraws) continue
    const s = worst(
      lineStatus(a.objectTriangles, b.objectTriangles, G.objectTriangles), lineStatus(a.placements, b.placements, G.placements),
      lineStatus(a.models, b.models, G.models), lineStatus(a.separateDraws, b.separateDraws, G.separateDraws),
    )
    const grew = a.objectTriangles - b.objectTriangles
    const bench1 = grew > 5000 || (b.objectTriangles > 0 && grew > b.objectTriangles * 0.1) || (b.objectTriangles === 0 && grew > 0)
    benchNeeded ||= bench1
    status = worst(status, s)
    regions.push({ region: regionName(id), before: b, after: a, status: s, ...(bench1 ? { benchNeeded: true } : {}) })
  }
  const world: Record<string, unknown> = {}
  const slotsB = treeSlots(input.scene.before)
  const slotsA = treeSlots(input.scene.after)
  const sSlots = lineStatus(slotsA, slotsB, G.treeSlots)
  world.treeSlots = { before: slotsB, after: slotsA, status: sSlots }
  status = worst(status, sSlots)
  if (input.lights) {
    const n = lightDensity(input.lights)
    const s = lineStatus(n, 0, G.lightPointsWithin60m)
    world.lightPointsWithin60m = { max: n, status: s }
    status = worst(status, s)
  }
  if (input.zones) {
    const n = zoneOverlap(input.zones)
    const s = lineStatus(n, 0, G.zonesPerPoint)
    world.zonesPerPoint = { max: n, status: s }
    status = worst(status, s)
  }
  if (bench) status = worst(status, bench.status)
  const over = regions.filter(r => r.status !== 'pass').map(r => r.region)
  const summary = status === 'stop'
    ? `Past a hard line: ${over.join(', ') || 'see the details'}${bench?.status === 'stop' ? `; ${bench.summary}` : ''}.`
    : status === 'warn'
      ? `Near a line: ${over.join(', ') || 'see the details'}.`
      : `${regions.length} changed region(s), all inside the lines.`
  return row('budgets', status, summary + (benchNeeded && !bench ? ' The Publish bench must run (triangles grew > 10 % or > 5 k).' : ''),
    { regions, world, benchNeeded, ...(bench ? { bench: { status: bench.status, summary: bench.summary, details: bench.details } } : {}) })
}

// --- inputs from the export's files ----------------------------------------------------------------------------------

/** Check points from the exported data files (nests.json, npcs.json, towns.json, manifest.places, probes.json rows). */
export function checkPointsFrom(src: {
  nests?: ReadonlyArray<{ id: number | string; x: number; z: number; y?: number; enabled?: boolean; inConvertedRegion?: boolean }>
  npcs?: ReadonlyArray<{ code: string; name?: string; x: number; z: number; inConvertedRegion?: boolean }>
  towns?: ReadonlyArray<{ code: string; name?: string; spawn?: { x: number; y: number; z: number } }>
  places?: ReadonlyArray<{ name: string; x: number; y: number; z: number }>
  probes?: ReadonlyArray<{ id: string; name: string; x: number; z: number; y?: number }>
}): CheckPoint[] {
  const out: CheckPoint[] = []
  for (const n of src.nests ?? []) {
    if (n.enabled === false || n.inConvertedRegion === false) continue
    out.push({ kind: 'nest', id: String(n.id), x: n.x, z: n.z })
  }
  for (const n of src.npcs ?? []) {
    if (n.inConvertedRegion === false) continue
    out.push({ kind: 'npc', id: n.code, ...(n.name ? { name: n.name } : {}), x: n.x, z: n.z })
  }
  for (const t of src.towns ?? []) if (t.spawn) out.push({ kind: 'gate', id: t.code, ...(t.name ? { name: t.name } : {}), x: t.spawn.x, z: t.spawn.z, y: t.spawn.y })
  for (const p of src.places ?? []) out.push({ kind: 'place', id: p.name, name: p.name, x: p.x, z: p.z, y: p.y })
  for (const p of src.probes ?? []) out.push({ kind: 'probe', id: p.id, name: p.name, x: p.x, z: p.z, ...(p.y !== undefined ? { y: p.y } : {}) })
  return out
}

/** LOD0 triangles of a .glb (index counts / 3, or vertex counts / 3 without indices) from its JSON chunk; 0 if unreadable. */
export function glbTriangleCount(bytes: Uint8Array): number {
  if (bytes.byteLength < 20) return 0
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) return 0
  const len = dv.getUint32(12, true)
  if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + len > bytes.byteLength) return 0
  try {
    const js = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as {
      meshes?: Array<{ primitives: Array<{ indices?: number; attributes: Record<string, number> }> }>
      accessors?: Array<{ count: number }>
    }
    let t = 0
    for (const m of js.meshes ?? []) {
      for (const p of m.primitives) {
        const acc = p.indices !== undefined ? js.accessors?.[p.indices] : js.accessors?.[p.attributes.POSITION ?? -1]
        t += Math.floor((acc?.count ?? 0) / 3)
      }
    }
    return t
  } catch {
    return 0
  }
}
