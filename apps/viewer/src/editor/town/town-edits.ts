/**
 * The Routes tool's model (docs/WORLD_EDITOR.md §4.11, §F4, §F18, D32; docs/WAVE_PLAN8.md D12, lane WE-T): the town
 * file (`content/town/jangan.json`) and its dressing (`jangan-dressing.json`) as the page edits them. Node, edge and
 * seat changes go into the file the crowd previews AND into its `manual` overlay (TownManualLog), which `pnpm sro
 * town-graph` keeps and applies after it regenerates the graph, so a rebuild keeps every hand edit. Dressing props
 * are edited by row `id` (never by uid: their uids are 1,000,000 + row order, §F4); the bench or stall place built on a
 * moved prop moves with it (a rebuild makes it there again from the row), and a deleted prop takes its place along.
 *
 * Every change is one undo step (a snapshot of both files: they are small). Pure: no Babylon, no DOM; the navmesh
 * comes in as a TownChecker (the page's TownNav on its live navmesh; tests pass their own).
 */
import type { TownDressingFile, TownFile, TownNode, TownPlace, TownProp, TownSeat, TownSeatPose } from '../../../../../packages/shared/src/town.ts'
import { validateTownFile } from '../../../../../packages/shared/src/town.ts'
import {
  TownManualLog, addTownEdge, cutTownEdge, hasTownEdge, moveTownNode, nextManualNodeId, r2, removeTownNode, repairTownRefs,
  townManualCount, type TownManual,
} from '../../../../../packages/shared/src/town-manual.ts'

/** What the model asks of the navmesh. */
export interface TownChecker {
  /** The edge rule (build-graph's segment check + feet on the ground); null: walkable. */
  edge(a: TownNode, b: TownNode): string | null
  /** A place's link from its node (the seats' clearance, the prop's own keep-out ignored); null: walkable. */
  link?(n: TownNode, p: TownPlace, row: TownProp | null): string | null
  /** The walkable ground height at (x, z) nearest `hint` (null: none: off the town's walkable ground). */
  ground(x: number, z: number, hint?: number): number | null
  /** The dressing changed (its rows are keep-outs for the edge rule). */
  rows?(dressing: TownDressingFile | null): void
}

export interface TownFiles {
  town: TownFile
  dressing: TownDressingFile | null
}

/** What the page selects. */
export type TownPick =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; a: string; b: string }
  | { kind: 'seat'; place: string; index: number }
  | { kind: 'place'; id: string }
  | { kind: 'row'; id: string }

interface Snapshot {
  town: TownFile
  dressing: TownDressingFile | null
  manual: TownManual
  label: string
  checked: string[]
}

/** Places built on a dressing prop: benches and stalls with a seat within this of the prop (m). */
const ROW_PLACE_M = 1.6
/** A place relinks to one of this many nearest nodes within this (m) (build-graph's linkNode). */
const LINK_NODES = 6
const LINK_M = 16

const clone = <T>(v: T): T => structuredClone(v)
const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

export class TownEdits {
  town: TownFile
  dressing: TownDressingFile | null
  readonly log: TownManualLog
  /** Changes since the last save. */
  unsaved = 0
  private undos: Snapshot[] = []
  private redos: Snapshot[] = []
  /** Edges this session touched (checked on the navmesh), by key; the value is the last problem (null: good). */
  private readonly checked = new Map<string, string | null>()
  /** The dressing rows' ids the session moved or deleted (the page re-places their props). */
  readonly touchedRows = new Set<string>()

  constructor(files: TownFiles, private checker: TownChecker | null = null) {
    this.town = clone(files.town)
    this.dressing = files.dressing ? clone(files.dressing) : null
    this.log = new TownManualLog(clone(this.town.manual ?? {}))
    ensureRowIds(this.dressing)
    this.checker?.rows?.(this.dressing)
  }

  setChecker(c: TownChecker | null): void {
    this.checker = c
    c?.rows?.(this.dressing)
    for (const k of [...this.checked.keys()]) this.recheck(k)
  }

  get manualCount(): number {
    return townManualCount(this.log.manual)
  }

  get canUndo(): boolean {
    return this.undos.length > 0
  }

  get canRedo(): boolean {
    return this.redos.length > 0
  }

  node(id: string): TownNode | undefined {
    return this.town.graph.nodes.find(n => n.id === id)
  }

  place(id: string): TownPlace | undefined {
    return this.town.places.find(p => p.id === id)
  }

  row(id: string): TownProp | undefined {
    return this.dressing?.props.find(p => p.id === id) ?? (this.dressing?.banners.find(b => b.id === id) as TownProp | undefined)
  }

  /** Every row with an id (props and banners). */
  rows(): TownProp[] {
    return this.dressing ? [...this.dressing.props, ...(this.dressing.banners as unknown as TownProp[])] : []
  }

  // ---- undo -------------------------------------------------------------------------------------------------------------

  private snap(label: string): Snapshot {
    return { town: clone(this.town), dressing: clone(this.dressing), manual: clone(this.log.manual), label, checked: [...this.checked.keys()] }
  }

  private begin(label: string): void {
    this.undos.push(this.snap(label))
    if (this.undos.length > 200) this.undos.shift()
    this.redos = []
  }

  private done(): void {
    this.unsaved++
    this.town.graph.edges = this.town.graph.edges.filter(e => this.node(e.a) && this.node(e.b))
    repairTownRefs(this.town)
  }

  private restore(s: Snapshot): void {
    this.town = s.town
    this.dressing = s.dressing
    this.log.manual = s.manual
    this.checker?.rows?.(this.dressing)
    this.checked.clear()
    for (const k of s.checked) this.recheck(k)
  }

  /** Undoes the last change; its label, or null. */
  undo(): string | null {
    const s = this.undos.pop()
    if (!s) return null
    this.redos.push(this.snap(s.label))
    this.restore(s)
    this.unsaved++
    return s.label
  }

  redo(): string | null {
    const s = this.redos.pop()
    if (!s) return null
    this.undos.push(this.snap(s.label))
    this.restore(s)
    this.unsaved++
    return s.label
  }

  // ---- the navmesh check ------------------------------------------------------------------------------------------------

  private recheck(key: string): void {
    const [a, b] = key.split('|') as [string, string]
    const na = this.node(a)
    const nb = this.node(b)
    if (!na || !nb || !hasTownEdge(this.town, a, b)) {
      this.checked.delete(key)
      return
    }
    this.checked.set(key, this.checker ? this.checker.edge(na, nb) : null)
  }

  private checkAround(id: string): void {
    for (const e of this.town.graph.edges) if (e.a === id || e.b === id) this.recheck(edgeKey(e.a, e.b))
  }

  /** The problem of an edge the session touched (null: good or never checked). */
  problem(a: string, b: string): string | null {
    return this.checked.get(edgeKey(a, b)) ?? null
  }

  /** Edges that fail the navmesh rule (drawn red; Save waits until none is left). */
  redEdges(): Array<{ a: string; b: string; why: string }> {
    const out: Array<{ a: string; b: string; why: string }> = []
    for (const [k, why] of this.checked) {
      if (!why) continue
      const [a, b] = k.split('|') as [string, string]
      out.push({ a, b, why })
    }
    return out
  }

  private y(x: number, z: number, hint?: number): number | undefined {
    const y = this.checker?.ground(x, z, hint)
    return y === null || y === undefined ? undefined : r2(y)
  }

  // ---- nodes and edges --------------------------------------------------------------------------------------------------

  /** A new node at (x, z), joined to `join` when given; refuses ground nobody walks on, or an edge that fails. */
  addNode(x: number, z: number, join?: string): { node: TownNode | null; problem: string | null } {
    const y = this.y(x, z)
    if (this.checker && y === undefined) return { node: null, problem: 'that ground is not walkable from town (a roof, a house, water or closed ground)' }
    const node: TownNode = { id: nextManualNodeId(this.town, this.log.manual), x: r2(x), z: r2(z), ...(y !== undefined ? { y } : {}) }
    const from = join ? this.node(join) : undefined
    if (from) {
      const why = this.checker?.edge(from, node) ?? null
      if (why) return { node: null, problem: why }
    }
    this.begin(from ? 'Add a path point' : 'Add a lone path point')
    this.town.graph.nodes.push(node)
    this.log.addNode(node)
    if (from) {
      addTownEdge(this.town, from.id, node.id)
      this.log.addEdge(from, node)
      this.checked.set(edgeKey(from.id, node.id), null)
    }
    this.done()
    return { node, problem: null }
  }

  /** Moves a node (its edges are re-checked: red ones wait for a fix). */
  moveNode(id: string, x: number, z: number): string | null {
    const n = this.node(id)
    if (!n) return 'no such node'
    const y = this.y(x, z, n.y)
    if (this.checker && y === undefined) return 'that ground is not walkable from town'
    this.begin('Move a path point')
    this.log.moveNode(n, x, z, y)
    moveTownNode(this.town, id, x, z, y)
    this.done()
    this.checkAround(id)
    return null
  }

  removeNode(id: string): boolean {
    const n = this.node(id)
    if (!n) return false
    this.begin('Delete a path point')
    this.log.removeNode(n)
    removeTownNode(this.town, id)
    this.done()
    for (const k of [...this.checked.keys()]) if (k.split('|').includes(id)) this.checked.delete(k)
    return true
  }

  /** Joins two nodes; the problem when the navmesh refuses (nothing changes then). */
  addEdge(a: string, b: string): string | null {
    const na = this.node(a)
    const nb = this.node(b)
    if (!na || !nb || a === b) return 'pick two different path points'
    if (hasTownEdge(this.town, a, b)) return 'they are already joined'
    const why = this.checker?.edge(na, nb) ?? null
    if (why) return why
    this.begin('Join two path points')
    addTownEdge(this.town, a, b)
    this.log.addEdge(na, nb)
    this.checked.set(edgeKey(a, b), null)
    this.done()
    return null
  }

  cutEdge(a: string, b: string): boolean {
    const na = this.node(a)
    const nb = this.node(b)
    if (!na || !nb || !hasTownEdge(this.town, a, b)) return false
    this.begin('Cut a path')
    cutTownEdge(this.town, a, b)
    this.log.cutEdge(na, nb)
    this.checked.delete(edgeKey(a, b))
    this.done()
    return true
  }

  // ---- seats ------------------------------------------------------------------------------------------------------------

  addSeat(placeId: string, x: number, z: number, yaw: number, pose: TownSeatPose = 'chair'): string | null {
    const p = this.place(placeId)
    if (!p) return 'no such place'
    if (Math.hypot(x - p.x, z - p.z) > 8) return 'a seat stays within 8 m of its place'
    const y = this.y(x, z, p.y)
    const seat: TownSeat = { x: r2(x), z: r2(z), ...(y !== undefined ? { y } : {}), yaw: r2(yaw), pose }
    this.begin('Add a seat')
    ;(p.seats ??= []).push(seat)
    this.log.addSeat(p, seat)
    this.done()
    return null
  }

  moveSeat(placeId: string, index: number, x: number, z: number, yaw: number): string | null {
    const p = this.place(placeId)
    const s = p?.seats?.[index]
    if (!p || !s) return 'no such seat'
    if (Math.hypot(x - p.x, z - p.z) > 8) return 'a seat stays within 8 m of its place'
    const y = this.y(x, z, s.y) ?? s.y
    this.begin(Math.hypot(x - s.x, z - s.z) < 0.01 ? 'Turn a seat' : 'Move a seat')
    this.log.moveSeat(s, x, z, y, yaw)
    p.seats![index] = { x: r2(x), z: r2(z), ...(y !== undefined ? { y: r2(y) } : {}), yaw: r2(yaw), pose: s.pose }
    this.done()
    return null
  }

  removeSeat(placeId: string, index: number): string | null {
    const p = this.place(placeId)
    const s = p?.seats?.[index]
    if (!p || !s) return 'no such seat'
    if (p.seats!.length === 1) return 'the last seat of a place stays (delete the bench or stall itself instead)'
    this.begin('Delete a seat')
    this.log.removeSeat(s)
    p.seats!.splice(index, 1)
    this.done()
    return null
  }

  // ---- dressing rows ------------------------------------------------------------------------------------------------

  /** The bench and stall places built on a row (a seat by the prop). */
  placesOfRow(row: TownProp): TownPlace[] {
    return this.town.places.filter(p => (p.kind === 'bench' || p.kind === 'stall') && (p.seats ?? []).some(s => Math.hypot(s.x - row.x, s.z - row.z) < ROW_PLACE_M))
  }

  /** Moves or turns a dressing prop by its row id; its places move with it (rigidly) and relink to a node. */
  moveRow(id: string, x: number, z: number, yaw: number): string | null {
    const row = this.row(id)
    if (!row) return 'no such prop row'
    const places = this.placesOfRow(row)
    const dYaw = yaw - row.yaw
    const c = Math.cos(dYaw)
    const s = Math.sin(dYaw)
    // +yaw about +Y (the dressing's convention): x' = x c + z s, z' = -x s + z c, about the prop's old spot
    const map = (px: number, pz: number) => {
      const dx = px - row.x
      const dz = pz - row.z
      return { x: x + dx * c + dz * s, z: z - dx * s + dz * c }
    }
    this.begin(Math.hypot(x - row.x, z - row.z) < 0.01 ? 'Turn a town prop' : 'Move a town prop')
    for (const p of places) {
      this.log.carrySeats(p, map, dYaw)
      const w = map(p.x, p.z)
      const py = this.y(w.x, w.z, p.y)
      Object.assign(p, { x: r2(w.x), z: r2(w.z), yaw: r2(p.yaw + dYaw) })
      if (py !== undefined) p.y = py
      p.seats = (p.seats ?? []).map(st => {
        const v = map(st.x, st.z)
        const sy = this.y(v.x, v.z, st.y)
        return { x: r2(v.x), z: r2(v.z), ...(st.y !== undefined ? { y: sy ?? st.y } : {}), yaw: r2(st.yaw + dYaw), pose: st.pose }
      })
    }
    row.x = r2(x)
    row.z = r2(z)
    row.yaw = r2(yaw)
    delete row.y
    this.touchedRows.add(id)
    this.checker?.rows?.(this.dressing)
    for (const p of places) this.relink(p, row)
    this.done()
    // edges near the prop's new spot may now cross it
    for (const e of this.town.graph.edges) {
      const a = this.node(e.a)!
      const b = this.node(e.b)!
      if (segDist(x, z, a.x, a.z, b.x, b.z) < 4) this.recheck(edgeKey(e.a, e.b))
    }
    return null
  }

  /** Deletes a dressing prop by its row id, and the places built on it. */
  removeRow(id: string): boolean {
    const row = this.row(id)
    if (!row || !this.dressing) return false
    const places = new Set(this.placesOfRow(row))
    this.begin('Delete a town prop')
    this.dressing.props = this.dressing.props.filter(p => p.id !== id)
    this.dressing.banners = this.dressing.banners.filter(b => b.id !== id)
    this.town.places = this.town.places.filter(p => !places.has(p))
    this.touchedRows.add(id)
    this.checker?.rows?.(this.dressing)
    this.done()
    return true
  }

  /** The place's node: the nearest whose link passes (build-graph's linkNode order), else the nearest. */
  private relink(p: TownPlace, row: TownProp | null): void {
    const near = this.town.graph.nodes
      .map(n => ({ n, d: Math.hypot(n.x - p.x, n.z - p.z) }))
      .filter(e => e.d <= LINK_M)
      .sort((a, b) => a.d - b.d || (a.n.id < b.n.id ? -1 : 1))
      .slice(0, LINK_NODES)
    const ok = near.find(({ n }) => !this.checker?.link || this.checker.link(n, p, row) === null)
    const pick = ok ?? near[0]
    if (pick) p.node = pick.n.id
  }

  // ---- save ------------------------------------------------------------------------------------------------------------

  /** The files to save (the overlay compacted), or the reasons they can't be saved yet. */
  payload(): { files: TownFiles | null; problems: string[] } {
    const problems: string[] = []
    const red = this.redEdges()
    if (red.length) problems.push(`${red.length} red path${red.length === 1 ? '' : 's'} cross${red.length === 1 ? 'es' : ''} ground nobody walks on: move the point or delete the path (first: ${red[0]!.why})`)
    const town: TownFile = { ...this.town }
    const manual = this.log.compact()
    if (Object.keys(manual).length) town.manual = manual
    else delete town.manual
    const v = validateTownFile(town)
    if (!v.ok) problems.push(...v.problems.slice(0, 5))
    if (this.dressing) {
      const d = validateTownFile(this.dressing)
      if (!d.ok) problems.push(...d.problems.slice(0, 5))
    }
    return { files: problems.length ? null : { town, dressing: this.dressing }, problems }
  }

  markSaved(): void {
    this.unsaved = 0
  }
}

/** Gives every prop and banner row an id (the editor addresses rows by id, §F4); returns how many it added. */
export function ensureRowIds(d: TownDressingFile | null): number {
  if (!d) return 0
  const used = new Set([...d.props, ...d.banners].map(r => r.id).filter((v): v is string => !!v))
  let added = 0
  for (const r of [...d.props, ...d.banners]) {
    if (r.id) continue
    const base = (r.model.split(/[\\/]/).pop() ?? 'prop').replace(/\.[a-z0-9]+$/i, '').toLowerCase()
    let k = 0
    while (used.has(`${base}-e${k}`)) k++
    r.id = `${base}-e${k}`
    used.add(r.id)
    added++
  }
  return added
}

function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz))
}
