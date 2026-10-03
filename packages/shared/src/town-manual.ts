/**
 * The town file's `manual` overlay (docs/WORLD_EDITOR.md §4.11, §F18, D32; docs/WAVE_PLAN8.md D12, lane WE-T): the
 * World Editor's hand edits of the route graph and the seats, kept by position because `pnpm sro town-graph`
 * regenerates every node, edge, place and seat from the navmesh on each run (their ids change). build-graph keeps the
 * overlay like the other authored parts and applies it after regeneration (`applyTownManual`); the editor applies the
 * same primitives to the file it shows and records each change here (`TownManualLog`), so a rebuild on the same
 * navmesh gives the graph the editor saved.
 *
 * Positions are glTF metres rounded to 0.01 m, as the graph's. Order of application: removed nodes, moved nodes, added
 * nodes, cut edges, added edges, removed seats, moved seats, added seats; then the references are repaired
 * (`repairTownRefs`: places relinked, broken routes re-pathed, fixed agents on missing seats dropped).
 *
 * Environment-neutral (the converter and the editor page both run it).
 */
import { TOWN_SEAT_POSES, type TownEdge, type TownFile, type TownNode, type TownPlace, type TownSeat, type TownSeatPose } from './town.ts'

/** A point [x, z] (glTF m). */
export type TownXZ = [number, number]

/** A node the user added (ids `m<k>`, never reused by the generator's `n` / `p` / `s` ids). */
export interface TownManualNode {
  id: string
  x: number
  z: number
  y?: number
}

/** A generated node the user moved ("pinned"): the node at `from` stands at (x, z). */
export interface TownManualMove {
  from: TownXZ
  x: number
  z: number
  y?: number
}

/** An edge between the nodes at two points (their positions after the moves). */
export interface TownManualEdge {
  a: TownXZ
  b: TownXZ
}

/** A seat the user added to the place nearest `place`. */
export interface TownManualSeat {
  place: TownXZ
  x: number
  z: number
  y?: number
  yaw: number
  pose: TownSeatPose
}

/** A generated seat the user moved or turned: the seat at `from` sits at (x, z) facing yaw. */
export interface TownManualSeatMove {
  from: TownXZ
  x: number
  z: number
  y?: number
  yaw: number
}

export interface TownManual {
  nodes?: TownManualNode[]
  moved?: TownManualMove[]
  /** Generated nodes removed (with their edges). */
  removed?: TownXZ[]
  edges?: TownManualEdge[]
  /** Edges removed. */
  cut?: TownManualEdge[]
  seats?: TownManualSeat[]
  seatsMoved?: TownManualSeatMove[]
  seatsRemoved?: TownXZ[]
}

/** A manual entry finds its node within this (m): a rebuild on a re-cut navmesh may shift a generated node a little. */
export const TOWN_MANUAL_MATCH_M = 1
/** ... and its seat within this (m). */
export const TOWN_MANUAL_SEAT_MATCH_M = 0.5
/** An added seat goes to the place nearest its `place` point within this (m). */
export const TOWN_MANUAL_PLACE_MATCH_M = 3

const MANUAL_ID = /^m\d+$/

export const r2 = (v: number): number => Math.round(v * 100) / 100
export const xzOf = (p: { x: number; z: number }): TownXZ => [r2(p.x), r2(p.z)]
const near = (p: TownXZ, q: { x: number; z: number }, d = 0.011) => Math.abs(p[0] - q.x) < d && Math.abs(p[1] - q.z) < d
const sameXZ = (a: TownXZ, b: TownXZ) => Math.abs(a[0] - b[0]) < 0.011 && Math.abs(a[1] - b[1]) < 0.011

/** True when the overlay holds nothing. */
export function townManualEmpty(m: TownManual | undefined | null): boolean {
  if (!m) return true
  return !(m.nodes?.length || m.moved?.length || m.removed?.length || m.edges?.length || m.cut?.length || m.seats?.length || m.seatsMoved?.length || m.seatsRemoved?.length)
}

/** Number of entries (the editor's "hand edits" count). */
export function townManualCount(m: TownManual | undefined | null): number {
  if (!m) return 0
  return (m.nodes?.length ?? 0) + (m.moved?.length ?? 0) + (m.removed?.length ?? 0) + (m.edges?.length ?? 0) + (m.cut?.length ?? 0) +
    (m.seats?.length ?? 0) + (m.seatsMoved?.length ?? 0) + (m.seatsRemoved?.length ?? 0)
}

// ---- validation ------------------------------------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isXZ = (v: unknown): v is TownXZ => Array.isArray(v) && v.length === 2 && v.every(isNum)

/** Problems of a `manual` block (paths as validateTownFile's: `town.manual.edges[2].a: ...`). */
export function townManualProblems(m: unknown): string[] {
  const out: string[] = []
  const w = 'town.manual'
  if (!isObj(m)) return [`${w}: expected an object`]
  const list = (k: string): unknown[] => {
    const v = m[k]
    if (v === undefined) return []
    if (!Array.isArray(v)) {
      out.push(`${w}.${k}: expected an array`)
      return []
    }
    return v
  }
  const xz = (o: Record<string, unknown>, at: string) => {
    if (!isNum(o.x) || !isNum(o.z)) out.push(`${at}: expected x, z numbers`)
    if (o.y !== undefined && !isNum(o.y)) out.push(`${at}.y: expected a number`)
  }
  const ids = new Set<string>()
  list('nodes').forEach((n, i) => {
    const at = `${w}.nodes[${i}]`
    if (!isObj(n)) return out.push(`${at}: expected an object`)
    if (typeof n.id !== 'string' || !MANUAL_ID.test(n.id)) out.push(`${at}.id: expected m<number> (the editor's own ids)`)
    else if (ids.has(n.id)) out.push(`${at}.id: duplicate node ${n.id}`)
    else ids.add(n.id)
    xz(n, at)
  })
  list('moved').forEach((n, i) => {
    const at = `${w}.moved[${i}]`
    if (!isObj(n)) return out.push(`${at}: expected an object`)
    if (!isXZ(n.from)) out.push(`${at}.from: expected [x, z]`)
    xz(n, at)
  })
  list('removed').forEach((p, i) => {
    if (!isXZ(p)) out.push(`${w}.removed[${i}]: expected [x, z]`)
  })
  for (const k of ['edges', 'cut']) {
    list(k).forEach((e, i) => {
      const at = `${w}.${k}[${i}]`
      if (!isObj(e) || !isXZ(e.a) || !isXZ(e.b)) return out.push(`${at}: expected {a: [x, z], b: [x, z]}`)
      if (sameXZ(e.a, e.b)) out.push(`${at}: an edge needs two different points`)
    })
  }
  list('seats').forEach((s, i) => {
    const at = `${w}.seats[${i}]`
    if (!isObj(s)) return out.push(`${at}: expected an object`)
    if (!isXZ(s.place)) out.push(`${at}.place: expected [x, z]`)
    xz(s, at)
    if (!isNum(s.yaw)) out.push(`${at}.yaw: expected a number`)
    if (typeof s.pose !== 'string' || !(TOWN_SEAT_POSES as readonly string[]).includes(s.pose)) out.push(`${at}.pose: expected one of ${TOWN_SEAT_POSES.join(', ')}`)
  })
  list('seatsMoved').forEach((s, i) => {
    const at = `${w}.seatsMoved[${i}]`
    if (!isObj(s)) return out.push(`${at}: expected an object`)
    if (!isXZ(s.from)) out.push(`${at}.from: expected [x, z]`)
    xz(s, at)
    if (!isNum(s.yaw)) out.push(`${at}.yaw: expected a number`)
  })
  list('seatsRemoved').forEach((p, i) => {
    if (!isXZ(p)) out.push(`${w}.seatsRemoved[${i}]: expected [x, z]`)
  })
  return out
}

// ---- primitives (the editor's and the rebuild's) -------------------------------------------------------------------

/** The node nearest (x, z) within `max` m (ties: the lower index), skipping `skip`. */
export function nearestTownNode(nodes: readonly TownNode[], x: number, z: number, max = TOWN_MANUAL_MATCH_M, skip?: ReadonlySet<string>): TownNode | null {
  let best: TownNode | null = null
  let bd = max
  for (const n of nodes) {
    if (skip?.has(n.id)) continue
    const d = Math.hypot(n.x - x, n.z - z)
    if (d <= bd && (!best || d < bd)) {
      best = n
      bd = d
    }
  }
  return best
}

/** The seat nearest (x, z) within `max` m: its place and index. */
export function nearestTownSeat(places: readonly TownPlace[], x: number, z: number, max = TOWN_MANUAL_SEAT_MATCH_M): { place: TownPlace; index: number } | null {
  let best: { place: TownPlace; index: number } | null = null
  let bd = max
  for (const p of places) {
    p.seats?.forEach((s, i) => {
      const d = Math.hypot(s.x - x, s.z - z)
      if (d <= bd && (!best || d < bd)) {
        best = { place: p, index: i }
        bd = d
      }
    })
  }
  return best
}

export function hasTownEdge(file: TownFile, a: string, b: string): boolean {
  return file.graph.edges.some(e => (e.a === a && e.b === b) || (e.a === b && e.b === a))
}

/** Removes a node and its edges. */
export function removeTownNode(file: TownFile, id: string): void {
  file.graph.nodes = file.graph.nodes.filter(n => n.id !== id)
  file.graph.edges = file.graph.edges.filter(e => e.a !== id && e.b !== id)
}

export function moveTownNode(file: TownFile, id: string, x: number, z: number, y?: number): void {
  const n = file.graph.nodes.find(k => k.id === id)
  if (!n) return
  n.x = r2(x)
  n.z = r2(z)
  if (y !== undefined && Number.isFinite(y)) n.y = r2(y)
  else delete n.y
}

/** Adds an edge a-b (no duplicate, no loop); false when not added. */
export function addTownEdge(file: TownFile, a: string, b: string): boolean {
  if (a === b || hasTownEdge(file, a, b)) return false
  if (!file.graph.nodes.some(n => n.id === a) || !file.graph.nodes.some(n => n.id === b)) return false
  file.graph.edges.push({ a, b })
  return true
}

export function cutTownEdge(file: TownFile, a: string, b: string): boolean {
  const n = file.graph.edges.length
  file.graph.edges = file.graph.edges.filter(e => !((e.a === a && e.b === b) || (e.a === b && e.b === a)))
  return file.graph.edges.length !== n
}

/** The next free editor node id (m<k>). */
export function nextManualNodeId(file: TownFile, manual?: TownManual): string {
  let k = 0
  for (const n of [...file.graph.nodes, ...(manual?.nodes ?? [])]) {
    if (MANUAL_ID.test(n.id)) k = Math.max(k, Number(n.id.slice(1)) + 1)
  }
  return `m${k}`
}

const seatOf = (s: { x: number; z: number; y?: number; yaw: number; pose: TownSeatPose }): TownSeat =>
  ({ x: r2(s.x), z: r2(s.z), ...(s.y !== undefined && Number.isFinite(s.y) ? { y: r2(s.y) } : {}), yaw: r2(s.yaw), pose: s.pose })

/** The place nearest (x, z) within `max` m. */
export function nearestTownPlace(places: readonly TownPlace[], x: number, z: number, max = TOWN_MANUAL_PLACE_MATCH_M): TownPlace | null {
  let best: TownPlace | null = null
  let bd = max
  for (const p of places) {
    const d = Math.hypot(p.x - x, p.z - z)
    if (d <= bd && (!best || d < bd)) {
      best = p
      bd = d
    }
  }
  return best
}

// ---- references ------------------------------------------------------------------------------------------------------

/** Neighbours of every node, in edge order. */
function adjacency(edges: readonly TownEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    ;(adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e.b)
    ;(adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push(e.a)
  }
  return adj
}

/** The shortest path a → b by hops then length (deterministic), both ends included; null when none. */
export function townPath(file: TownFile, a: string, b: string, adj = adjacency(file.graph.edges)): string[] | null {
  if (a === b) return [a]
  const pos = new Map(file.graph.nodes.map(n => [n.id, n]))
  if (!pos.has(a) || !pos.has(b)) return null
  // Dijkstra on metres (a few thousand nodes: a plain scan is enough)
  const dist = new Map<string, number>([[a, 0]])
  const prev = new Map<string, string>()
  const done = new Set<string>()
  const open = new Set([a])
  while (open.size) {
    let v = ''
    let vd = Infinity
    for (const k of open) {
      const d = dist.get(k)!
      if (d < vd || (d === vd && k < v)) {
        vd = d
        v = k
      }
    }
    open.delete(v)
    if (v === b) break
    done.add(v)
    const pv = pos.get(v)!
    for (const w of adj.get(v) ?? []) {
      if (done.has(w)) continue
      const pw = pos.get(w)
      if (!pw) continue
      const d = vd + Math.hypot(pw.x - pv.x, pw.z - pv.z)
      if (d < (dist.get(w) ?? Infinity)) {
        dist.set(w, d)
        prev.set(w, v)
        open.add(w)
      }
    }
  }
  if (!dist.has(b)) return null
  const path = [b]
  while (path[0] !== a) path.unshift(prev.get(path[0]!)!)
  return path
}

/**
 * After graph or seat edits: every place links to an existing node (the nearest, when its own is gone), routes walk
 * existing edges (a missing step is re-pathed over the graph; a route that can't close is dropped), and fixed agents
 * whose place or seat is gone are dropped. Returns what it changed.
 */
export function repairTownRefs(file: TownFile): string[] {
  const out: string[] = []
  const ids = new Set(file.graph.nodes.map(n => n.id))
  for (const p of file.places) {
    if (ids.has(p.node)) continue
    const n = nearestTownNode(file.graph.nodes, p.x, p.z, Infinity)
    if (!n) continue
    out.push(`place ${p.id}: its node ${p.node} is gone, linked to ${n.id}`)
    p.node = n.id
  }
  const adj = adjacency(file.graph.edges)
  const routes = file.folk.routes ?? []
  for (const r of [...routes]) {
    const kept = r.nodes.filter(n => ids.has(n))
    const path: string[] = []
    let ok = kept.length >= 2
    for (let i = 0; ok && i < kept.length; i++) {
      const a = kept[i]!
      const b = kept[(i + 1) % kept.length]!
      if (a === b) continue
      if (adj.get(a)?.includes(b)) {
        path.push(a)
        continue
      }
      const via = townPath(file, a, b, adj)
      if (!via) ok = false
      else path.push(...via.slice(0, -1))
    }
    // collapse repeats (a path back over its own step keeps both visits)
    const nodes = path.filter((n, i) => n !== path[(i + 1) % path.length])
    if (!ok || nodes.length < 2) {
      routes.splice(routes.indexOf(r), 1)
      out.push(`route ${r.id}: its nodes are no longer connected, dropped`)
      continue
    }
    if (nodes.length !== r.nodes.length || nodes.some((n, i) => n !== r.nodes[i])) {
      r.nodes = nodes
      out.push(`route ${r.id}: re-pathed round the edited graph`)
    }
  }
  const places = new Map(file.places.map(p => [p.id, p]))
  const fixed = file.folk.fixed ?? []
  for (const f of [...fixed]) {
    const p = places.get(f.place)
    if (p && (f.seat === undefined || f.seat < (p.seats?.length ?? 0))) continue
    fixed.splice(fixed.indexOf(f), 1)
    out.push(`fixed ${f.role} at ${f.place}${f.seat !== undefined ? ` seat ${f.seat}` : ''}: the seat is gone, dropped`)
  }
  return out
}

// ---- the rebuild's application -------------------------------------------------------------------------------------

export interface ApplyTownManualOptions {
  /**
   * The navmesh check of an edge (null: walkable). Added edges that fail are not applied (the overlay keeps them);
   * generated edges at a moved node that fail are removed. Absent: no check.
   */
  check?: (a: TownNode, b: TownNode) => string | null
}

/**
 * Applies the overlay to a freshly generated file, in place. Entries that match nothing (the navmesh changed under
 * them) are reported and skipped; the overlay itself is never changed (a rebuild keeps every manual edit).
 */
export function applyTownManual(file: TownFile, manual: TownManual | undefined | null, opts: ApplyTownManualOptions = {}): string[] {
  const out: string[] = []
  if (!manual || townManualEmpty(manual)) return out
  const nodes = () => file.graph.nodes
  const claimed = new Set<string>()
  let unmatched = 0
  const miss = (what: string) => {
    unmatched++
    out.push(`manual: ${what} matches nothing, skipped`)
  }
  for (const p of manual.removed ?? []) {
    const n = nearestTownNode(nodes(), p[0], p[1], TOWN_MANUAL_MATCH_M, claimed)
    if (!n) miss(`removed node (${p[0]}, ${p[1]})`)
    else removeTownNode(file, n.id)
  }
  const moved: string[] = []
  for (const m of manual.moved ?? []) {
    const n = nearestTownNode(nodes(), m.from[0], m.from[1], TOWN_MANUAL_MATCH_M, claimed)
    if (!n) {
      miss(`moved node (${m.from[0]}, ${m.from[1]})`)
      continue
    }
    claimed.add(n.id)
    moveTownNode(file, n.id, m.x, m.z, m.y)
    moved.push(n.id)
  }
  for (const m of manual.nodes ?? []) {
    const have = nodes().find(n => n.id === m.id)
    if (have) moveTownNode(file, m.id, m.x, m.z, m.y)
    else file.graph.nodes.push({ id: m.id, x: r2(m.x), z: r2(m.z), ...(m.y !== undefined ? { y: r2(m.y) } : {}) })
    claimed.add(m.id)
  }
  // edge ends: the node at the point (the exact one first; manual and moved nodes sit exactly there)
  const at = (p: TownXZ) => nodes().find(n => near(p, n)) ?? nearestTownNode(nodes(), p[0], p[1])
  for (const e of manual.cut ?? []) {
    const a = at(e.a)
    const b = at(e.b)
    if (!a || !b || !cutTownEdge(file, a.id, b.id)) miss(`cut edge (${e.a.join(', ')}) - (${e.b.join(', ')})`)
  }
  if (opts.check) {
    // generated edges at a moved node keep the navmesh rule, or go
    const byId = new Map(nodes().map(n => [n.id, n]))
    const set = new Set(moved)
    file.graph.edges = file.graph.edges.filter(e => {
      if (!set.has(e.a) && !set.has(e.b)) return true
      const why = opts.check!(byId.get(e.a)!, byId.get(e.b)!)
      if (why) out.push(`manual: edge ${e.a}-${e.b} at a moved node fails the navmesh check (${why}), removed`)
      return !why
    })
  }
  for (const e of manual.edges ?? []) {
    const a = at(e.a)
    const b = at(e.b)
    if (!a || !b || a === b) {
      miss(`edge (${e.a.join(', ')}) - (${e.b.join(', ')})`)
      continue
    }
    if (hasTownEdge(file, a.id, b.id)) continue
    const why = opts.check?.(a, b) ?? null
    if (why) {
      out.push(`manual: edge ${a.id}-${b.id} fails the navmesh check (${why}): kept in the overlay, not applied`)
      continue
    }
    addTownEdge(file, a.id, b.id)
  }
  for (const p of manual.seatsRemoved ?? []) {
    const s = nearestTownSeat(file.places, p[0], p[1])
    if (!s) miss(`removed seat (${p[0]}, ${p[1]})`)
    else s.place.seats!.splice(s.index, 1)
  }
  const movedSeats = new Set<TownSeat>()
  for (const m of manual.seatsMoved ?? []) {
    const s = nearestTownSeat(file.places, m.from[0], m.from[1])
    const seat = s ? s.place.seats![s.index]! : null
    if (!seat || movedSeats.has(seat)) {
      miss(`moved seat (${m.from[0]}, ${m.from[1]})`)
      continue
    }
    s!.place.seats![s!.index] = seatOf({ ...m, pose: seat.pose })
    movedSeats.add(s!.place.seats![s!.index]!)
  }
  for (const m of manual.seats ?? []) {
    const p = nearestTownPlace(file.places, m.place[0], m.place[1])
    if (!p) {
      miss(`seat (${m.x}, ${m.z}) of the place at (${m.place[0]}, ${m.place[1]})`)
      continue
    }
    if (p.seats?.some(s => Math.abs(s.x - m.x) < 0.011 && Math.abs(s.z - m.z) < 0.011)) continue
    ;(p.seats ??= []).push(seatOf(m))
  }
  out.push(...repairTownRefs(file))
  out.unshift(`manual: ${townManualCount(manual)} hand edits applied${unmatched ? ` (${unmatched} matched nothing)` : ''}`)
  return out
}

// ---- the editor's log (one change at a time, merged into the overlay) ----------------------------------------------

/**
 * Records editor changes into the overlay so that `applyTownManual` on the regenerated file reproduces them. Every
 * method takes the node or seat as it stands now (before the change) and keeps the overlay minimal: moving an added
 * node edits its entry, moving a moved node keeps its first `from`, removing an added edge drops the entry, and so on.
 * Edge entries hold the current positions of their ends, so a move rewrites them.
 */
export class TownManualLog {
  constructor(public manual: TownManual) {}

  private list<K extends keyof TownManual>(k: K): NonNullable<TownManual[K]> {
    return (this.manual[k] ??= [] as never) as NonNullable<TownManual[K]>
  }

  private rewriteEnds(from: TownXZ, to: TownXZ): void {
    for (const k of ['edges', 'cut'] as const) {
      for (const e of this.manual[k] ?? []) {
        if (sameXZ(e.a, from)) e.a = [...to]
        if (sameXZ(e.b, from)) e.b = [...to]
      }
    }
  }

  private dropEnds(p: TownXZ): void {
    for (const k of ['edges', 'cut'] as const) {
      const l = this.manual[k]
      if (l) this.manual[k] = l.filter(e => !sameXZ(e.a, p) && !sameXZ(e.b, p))
    }
  }

  addNode(n: TownNode): void {
    this.list('nodes').push({ id: n.id, x: r2(n.x), z: r2(n.z), ...(n.y !== undefined ? { y: r2(n.y) } : {}) })
  }

  /** `n` before the move. */
  moveNode(n: TownNode, x: number, z: number, y?: number): void {
    const cur = xzOf(n)
    const to: TownXZ = [r2(x), r2(z)]
    const yy = y !== undefined && Number.isFinite(y) ? { y: r2(y) } : {}
    const own = this.manual.nodes?.find(m => m.id === n.id)
    if (own) {
      own.x = to[0]
      own.z = to[1]
      delete own.y
      Object.assign(own, yy)
    } else {
      const mv = this.manual.moved?.find(m => sameXZ([m.x, m.z], cur))
      if (mv) {
        mv.x = to[0]
        mv.z = to[1]
        delete mv.y
        Object.assign(mv, yy)
        if (sameXZ(mv.from, to)) this.manual.moved = this.manual.moved!.filter(m => m !== mv)
      } else this.list('moved').push({ from: cur, x: to[0], z: to[1], ...yy })
    }
    this.rewriteEnds(cur, to)
    this.tidyEdges()
  }

  /** `n` before the removal. */
  removeNode(n: TownNode): void {
    const cur = xzOf(n)
    const own = this.manual.nodes?.find(m => m.id === n.id)
    if (own) this.manual.nodes = this.manual.nodes!.filter(m => m !== own)
    else {
      const mv = this.manual.moved?.find(m => sameXZ([m.x, m.z], cur))
      if (mv) this.manual.moved = this.manual.moved!.filter(m => m !== mv)
      this.list('removed').push(mv ? [...mv.from] : cur)
    }
    this.dropEnds(cur)
  }

  addEdge(a: TownNode, b: TownNode): void {
    const ea = xzOf(a)
    const eb = xzOf(b)
    const cut = this.manual.cut?.find(e => (sameXZ(e.a, ea) && sameXZ(e.b, eb)) || (sameXZ(e.a, eb) && sameXZ(e.b, ea)))
    if (cut) this.manual.cut = this.manual.cut!.filter(e => e !== cut)
    else this.list('edges').push({ a: ea, b: eb })
  }

  cutEdge(a: TownNode, b: TownNode): void {
    const ea = xzOf(a)
    const eb = xzOf(b)
    const add = this.manual.edges?.find(e => (sameXZ(e.a, ea) && sameXZ(e.b, eb)) || (sameXZ(e.a, eb) && sameXZ(e.b, ea)))
    if (add) this.manual.edges = this.manual.edges!.filter(e => e !== add)
    else this.list('cut').push({ a: ea, b: eb })
  }

  addSeat(place: TownPlace, s: TownSeat): void {
    this.list('seats').push({ place: xzOf(place), x: r2(s.x), z: r2(s.z), ...(s.y !== undefined ? { y: r2(s.y) } : {}), yaw: r2(s.yaw), pose: s.pose })
  }

  /** `s` before the move. */
  moveSeat(s: TownSeat, x: number, z: number, y: number | undefined, yaw: number): void {
    const cur = xzOf(s)
    const yy = y !== undefined && Number.isFinite(y) ? { y: r2(y) } : {}
    const own = this.manual.seats?.find(m => sameXZ([m.x, m.z], cur))
    if (own) {
      own.x = r2(x)
      own.z = r2(z)
      delete own.y
      Object.assign(own, yy, { yaw: r2(yaw) })
      return
    }
    const mv = this.manual.seatsMoved?.find(m => sameXZ([m.x, m.z], cur))
    if (mv) {
      mv.x = r2(x)
      mv.z = r2(z)
      delete mv.y
      Object.assign(mv, yy, { yaw: r2(yaw) })
    } else this.list('seatsMoved').push({ from: cur, x: r2(x), z: r2(z), ...yy, yaw: r2(yaw) })
  }

  /** `s` before the removal. */
  removeSeat(s: TownSeat): void {
    const cur = xzOf(s)
    const own = this.manual.seats?.find(m => sameXZ([m.x, m.z], cur))
    if (own) {
      this.manual.seats = this.manual.seats!.filter(m => m !== own)
      return
    }
    const mv = this.manual.seatsMoved?.find(m => sameXZ([m.x, m.z], cur))
    if (mv) this.manual.seatsMoved = this.manual.seatsMoved!.filter(m => m !== mv)
    this.list('seatsRemoved').push(mv ? [...mv.from] : cur)
  }

  /** Seat entries of a place that moved with its prop (a dressing row): moved by the same rigid step. */
  carrySeats(place: TownPlace, map: (x: number, z: number) => { x: number; z: number }, dYaw: number): void {
    const xs = (place.seats ?? []).map(xzOf)
    const hit = (p: TownXZ) => xs.some(q => sameXZ(p, q))
    for (const m of this.manual.seats ?? []) {
      if (!hit([m.x, m.z])) continue
      const w = map(m.x, m.z)
      const pl = map(m.place[0], m.place[1])
      Object.assign(m, { x: r2(w.x), z: r2(w.z), yaw: r2(m.yaw + dYaw), place: [r2(pl.x), r2(pl.z)] })
    }
    // a moved seat of the prop: the rebuild makes the prop's seats at its new spot, so `from` goes along
    for (const m of this.manual.seatsMoved ?? []) {
      if (!hit([m.x, m.z])) continue
      const w = map(m.x, m.z)
      const f = map(m.from[0], m.from[1])
      Object.assign(m, { x: r2(w.x), z: r2(w.z), yaw: r2(m.yaw + dYaw), from: [r2(f.x), r2(f.z)] })
    }
  }

  /** An added edge that is also cut, or a cut of an added one, cancels out. */
  private tidyEdges(): void {
    const key = (e: TownManualEdge) => [e.a.join(), e.b.join()].sort().join('|')
    const cut = new Set((this.manual.cut ?? []).map(key))
    const both = (this.manual.edges ?? []).filter(e => cut.has(key(e))).map(key)
    if (!both.length) return
    const drop = new Set(both)
    this.manual.edges = this.manual.edges!.filter(e => !drop.has(key(e)))
    this.manual.cut = this.manual.cut!.filter(e => !drop.has(key(e)))
  }

  /** The overlay without empty lists (what the file stores). */
  compact(): TownManual {
    const m: TownManual = {}
    for (const [k, v] of Object.entries(this.manual) as Array<[keyof TownManual, unknown[] | undefined]>) if (v?.length) (m as Record<string, unknown>)[k] = v
    return m
  }
}
