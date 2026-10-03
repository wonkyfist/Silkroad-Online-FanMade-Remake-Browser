/**
 * The Routes tool (T) of the World Editor (docs/WORLD_EDITOR.md §4.11, D32; WAVE_PLAN8 D12, lane WE-T): the town's
 * walking graph, its places and seats, and the town dressing's props, drawn over the map and edited by hand.
 *
 * - Path points (nodes) and paths (edges): click a point to pick it; click another to join them; click open ground to
 *   put a new point joined to the picked one (Shift: a lone point); drag a point to move it; right-click or Del
 *   deletes. Every path the user adds or moves is checked on the navmesh with build-graph's rule (the town's walkable
 *   component, off solid footprints and the dressing's props, steps ≤ 0.6 m, 0.4 m from nav edges, feet within
 *   0.25 m of the ground) and drawn red when it fails; Save waits until no red path is left.
 * - Seats: drag a seat to move it, `,` / `.` turn it, Shift+click by a picked place adds one, Del removes one.
 * - Town props (the dressing's benches, stalls, crates, banners): drag to move, `,` / `.` to turn, Del to delete; the
 *   rows of `jangan-dressing.json` change by id, the bench's seats go with it and the prop moves on the map at once.
 *
 * Every change also goes into the town file's `manual` overlay (./town-edits.ts), which `pnpm sro town-graph` keeps,
 * so a rebuild keeps every hand edit. The crowd re-plans on the edited file after each change (./town-preview.ts).
 */
import {
  Color4, MeshBuilder, Vector3,
  type LinesMesh, type PointerInfo, type Ray, type Scene,
} from '@babylonjs/core'
import type { World } from '@sro/world-render'
import type { WorldPlacement } from '../../../../../packages/convert/src/world/manifest.ts'
import {
  TownNav, checkTownEdge, dressingRowsWith, rowObstacle, townBaseName, townWater, type DressingRow,
} from '../../../../../packages/convert/src/town/town-nav.ts'
import type { TownDressingFile, TownFile, TownNode, TownPlace, TownProp } from '../../../../../packages/shared/src/town.ts'
import { townManualCount } from '../../../../../packages/shared/src/town-manual.ts'
import type { EditorApi } from '../api.ts'
import { TownEdits, type TownChecker, type TownFiles, type TownPick } from './town-edits.ts'
import type { TownLoad } from './town-store.ts'
import type { TownPreview } from './town-preview.ts'

/** Jangan's home point (build-graph JANGAN_GRAPH.home: the town spawn, in the walkable component). */
export const JANGAN_HOME = { x: 96.9, z: -136.9 }
/** The wave-11 dressing numbers its placements from here (convert world/town/dressing.ts TOWN_UID_BASE, §F4). */
export const DRESSING_UID_BASE = 1_000_000
/** A turn step for seats and props (radians). */
const TURN = Math.PI / 12
const LIFT_M = 0.15

const C = {
  edge: new Color4(0.3, 0.8, 1, 1),
  hand: new Color4(1, 0.8, 0.3, 1),
  red: new Color4(1, 0.15, 0.1, 1),
  pick: new Color4(1, 1, 1, 1),
  place: new Color4(0.45, 1, 0.45, 1),
  link: new Color4(0.3, 0.65, 0.3, 1),
  seat: new Color4(0.9, 0.5, 1, 1),
  row: new Color4(1, 0.55, 0.2, 1),
}

export interface TownToolHost {
  readonly scene: Scene
  readonly world: World
  readonly api: EditorApi
  readonly preview: TownPreview
  /** The edited ground under a ray. */
  groundHit(ray: Ray): Vector3 | null
  /** The camera's distance to a point (pick radius). */
  camDistance(x: number, y: number, z: number): number
  say(text: string, kind?: 'ok' | 'warn' | 'error'): void
  invalidate(): void
  canEdit(): boolean
  /** Re-batches regions whose placements the tool changed in place (the dressing props). */
  syncObjects(regions: ReadonlySet<number>): void
  homeOf(p: WorldPlacement): number
}

/** The page's navmesh as the model's checker: build-graph's TownNav on the editor's live navmesh. */
class PageChecker implements TownChecker {
  readonly nav: TownNav
  rowList: DressingRow[] = []
  private rowIds: string[] = []

  constructor(private readonly world: World) {
    const m = world.manifest
    this.nav = new TownNav(world.navWorld.data, m.space.originRegion, JANGAN_HOME, world.nav)
    this.nav.water = townWater(m)
  }

  get ok(): boolean {
    return this.nav.home >= 0
  }

  edge(a: TownNode, b: TownNode): string | null {
    return checkTownEdge(this.nav, a, b)
  }

  link(n: TownNode, p: TownPlace, row: TownProp | null): string | null {
    const ignore = row?.id ? this.rowIds.indexOf(row.id) : -1
    return this.nav.checkSegment(n.x, n.z, n.y ?? Infinity, p.x, p.z, p.y ?? Infinity, 0.25, ignore)
  }

  ground(x: number, z: number, hint?: number): number | null {
    return this.nav.ground(x, z, hint ?? Infinity)?.y ?? null
  }

  rows(d: TownDressingFile | null): void {
    this.rowList = dressingRowsWith(d, this.world.manifest)
    this.rowIds = d ? [...d.props, ...d.banners].map(r => r.id ?? '') : []
    this.nav.obstacles = this.rowList.map(rowObstacle)
  }
}

interface RowPlacement {
  p: WorldPlacement
  position: [number, number, number]
  yaw: number
  rotation: [number, number, number, number]
}

const yawQuat = (yaw: number): [number, number, number, number] => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
const samePick = (a: TownPick | null, b: TownPick | null) => JSON.stringify(a) === JSON.stringify(b)

export class TownTool {
  edits: TownEdits | null = null
  active = false
  selection: TownPick | null = null
  private checker: PageChecker | null = null
  private base: TownLoad['base'] = { town: null, dressing: null }
  private readOnlyWhy: string | null = null
  private mesh: LinesMesh | null = null
  private down: { x: number; y: number; pick: TownPick | null; button: number } | null = null
  private drag: { pick: TownPick; x: number; z: number } | null = null
  private readonly rowPlacements = new Map<string, RowPlacement>()
  private readonly synced = new Set<string>()
  private panel: HTMLElement | null = null

  /** The town files from the API (null without one); call it before loadWorld so the crowd can wait on it. */
  static async fetch(api: EditorApi): Promise<TownLoad | null> {
    if (!api.available) return null
    try {
      const res = await api.request('GET', 'town')
      if (!res.ok) return null
      return (await res.json()) as TownLoad
    } catch (err) {
      console.warn('[editor] the town files could not be read:', err)
      return null
    }
  }

  constructor(private readonly host: TownToolHost, load: TownLoad | null, fallback: TownFile | null = null) {
    const town = load?.town ?? fallback
    if (load?.problems.length) this.readOnlyWhy = `the town files on disk do not validate (${load.problems[0]})`
    else if (!load) this.readOnlyWhy = 'the editor API is not running, so town edits can\'t be saved'
    if (town) {
      this.edits = new TownEdits({ town, dressing: load?.dressing ?? null }, null)
      this.base = load?.base ?? { town: null, dressing: null }
      this.mapRows()
    }
    host.preview.setFile(this.edits?.town ?? null)
  }

  get unsaved(): number {
    return this.edits?.unsaved ?? 0
  }

  /** The keys line for the tool. */
  static readonly keys = '<span><kbd>Click</kbd>pick a point, seat or town prop</span><span><kbd>Click</kbd> a 2nd point: join them</span><span><kbd>Click</kbd> ground: a new point joined to the picked one</span><span><kbd>Shift</kbd>+click: a lone point, or a seat for the picked place</span><span><kbd>Drag</kbd>move it</span><span><kbd>,</kbd><kbd>.</kbd>turn</span><span><kbd>Del</kbd>/<kbd>Right-click</kbd>delete</span><span><kbd>Esc</kbd>deselect</span>'

  // ---- activation ----------------------------------------------------------------------------------------------------

  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    this.ensurePanel()
    this.panel?.classList.toggle('hidden', !on)
    if (on) {
      if (!this.edits) {
        this.host.say('Routes: the town file is not here (content/town/jangan.json); run pnpm sro town-graph first.', 'warn')
      } else {
        this.ensureChecker()
        this.host.say(this.checker?.ok
          ? 'Routes: blue paths are the town\'s walking graph (gold: yours), green rings its places, violet its seats, orange its props. Click to pick, drag to move.'
          : 'Routes: fly to Jangan first (the town\'s walking ground is not loaded here); the paths show, but changes wait for it.', this.checker?.ok ? 'ok' : 'warn')
      }
    } else {
      this.selection = null
      this.drag = null
    }
    this.draw()
    this.renderPanel()
  }

  private ensureChecker(): void {
    if (this.checker?.ok || !this.edits) return
    try {
      const c = new PageChecker(this.host.world)
      if (!c.ok) {
        this.checker = c
        return
      }
      this.checker = c
      this.edits.setChecker(c)
    } catch (err) {
      console.warn('[editor] the town navmesh check is not available:', err)
      this.checker = null
    }
  }

  private canChange(): boolean {
    if (!this.edits) return false
    if (!this.host.canEdit()) {
      this.host.say('This tab is read-only: another World Editor tab is open.', 'warn')
      return false
    }
    this.ensureChecker()
    if (!this.checker?.ok) {
      this.host.say('The town\'s walking ground is not loaded here: fly to Jangan, then try again.', 'warn')
      return false
    }
    return true
  }

  // ---- the dressing props on the map -----------------------------------------------------------------------------

  /** Each dressing row's placement in the export (same model within 0.5 m, dressing uids). */
  private mapRows(): void {
    if (!this.edits) return
    const claimed = new Set<WorldPlacement>()
    const list = this.host.world.manifest.placements.filter(p => p.uid >= DRESSING_UID_BASE)
    for (const r of this.edits.rows()) {
      if (!r.id) continue
      const name = townBaseName(r.model)
      const p = list.find(q => !claimed.has(q) && Math.abs(q.position[0]! - r.x) < 0.5 && Math.abs(q.position[2]! - r.z) < 0.5 && townBaseName(q.source) === name)
      if (!p) continue
      claimed.add(p)
      this.rowPlacements.set(r.id, { p, position: [p.position[0]!, p.position[1]!, p.position[2]!], yaw: p.yaw, rotation: [...p.rotation] as [number, number, number, number] })
    }
  }

  /** Whether an Objects-tool ref is a dressing prop (the Move tool hands those to this tool, §F4). */
  rowOfRef(ref: string): string | null {
    const m = /^r:(\d+):(\d+)$/.exec(ref)
    if (!m || Number(m[2]) < DRESSING_UID_BASE) return null
    for (const [id, rp] of this.rowPlacements) if (rp.p.region === Number(m[1]) && rp.p.uid === Number(m[2])) return id
    return null
  }

  select(pick: TownPick | null): void {
    this.selection = pick
    this.draw()
    this.renderPanel()
  }

  /** Moves the touched rows' placements to their rows (or sinks a deleted one) and re-batches their regions. */
  private syncRows(): void {
    if (!this.edits) return
    const regions = new Set<number>()
    for (const id of new Set([...this.edits.touchedRows, ...this.synced])) {
      const rp = this.rowPlacements.get(id)
      if (!rp) continue
      const row = this.edits.row(id)
      let pos: [number, number, number]
      let yaw: number
      if (row) {
        const g0 = this.checker?.ground(rp.position[0], rp.position[2], rp.position[1]) ?? rp.position[1]
        const g1 = this.checker?.ground(row.x, row.z, rp.position[1]) ?? this.host.world.regions.heightAt(row.x, row.z) ?? g0
        pos = [row.x, g1 + (rp.position[1] - g0), row.z]
        yaw = row.yaw
      } else {
        pos = [rp.position[0], rp.position[1] - 300, rp.position[2]]
        yaw = rp.yaw
      }
      const p = rp.p
      if (p.position[0] === pos[0] && p.position[1] === pos[1] && p.position[2] === pos[2] && p.yaw === yaw) continue
      regions.add(this.host.homeOf(p))
      p.position = pos
      p.yaw = yaw
      p.rotation = Math.abs(yaw - rp.yaw) < 1e-9 ? [...rp.rotation] as [number, number, number, number] : yawQuat(yaw)
      this.synced.add(id)
    }
    if (regions.size) this.host.syncObjects(regions)
  }

  // ---- after a change --------------------------------------------------------------------------------------------

  private changed(label: string | null, problem: string | null = null): void {
    if (problem) this.host.say(`Can't: ${problem}.`, 'warn')
    else if (label) {
      const red = this.edits?.redEdges().length ?? 0
      this.host.say(`${label}.${red ? ` ${red} path${red === 1 ? '' : 's'} red: ${this.edits!.redEdges()[0]!.why}. Move the point or delete the path.` : ''} Not saved yet.`, red ? 'warn' : 'ok')
    }
    if (!problem) {
      this.syncRows()
      this.host.preview.setFile(this.edits?.town ?? null)
      this.host.preview.refresh(this.host.world)
    }
    this.draw()
    this.renderPanel()
  }

  undo(): void {
    const l = this.edits?.undo() ?? null
    if (!l) return this.host.say('Nothing to undo in the town.')
    this.selection = null
    this.changed(`Undid: ${l}`)
  }

  redo(): void {
    const l = this.edits?.redo() ?? null
    if (!l) return this.host.say('Nothing to redo in the town.')
    this.selection = null
    this.changed(`Redid: ${l}`)
  }

  // ---- picking ---------------------------------------------------------------------------------------------------

  /** What lies under glTF (x, z): a seat, a path point, a place, a town prop, a path (in that order). */
  pickAt(x: number, z: number, y: number): TownPick | null {
    const e = this.edits
    if (!e) return null
    const r = Math.max(0.6, Math.min(4, this.host.camDistance(x, y, z) * 0.012))
    let best: { pick: TownPick; d: number } | null = null
    const take = (pick: TownPick, d: number, max: number) => {
      if (d <= max && (!best || d < best.d)) best = { pick, d }
    }
    for (const p of e.town.places) p.seats?.forEach((s, i) => take({ kind: 'seat', place: p.id, index: i }, Math.hypot(s.x - x, s.z - z), r * 0.6))
    if (best) return (best as { pick: TownPick }).pick
    for (const n of e.town.graph.nodes) take({ kind: 'node', id: n.id }, Math.hypot(n.x - x, n.z - z), r)
    if (best) return (best as { pick: TownPick }).pick
    for (const p of e.town.places) take({ kind: 'place', id: p.id }, Math.hypot(p.x - x, p.z - z), r * 0.8)
    if (best) return (best as { pick: TownPick }).pick
    const rows = this.checker?.rowList ?? dressingRowsWith(e.dressing, this.host.world.manifest)
    const ids = e.rows().map(r => r.id ?? '')
    rows.forEach((row, i) => {
      const o = rowObstacle(row)
      take({ kind: 'row', id: ids[i]! }, Math.hypot(o.x - x, o.z - z), Math.max(0.8, o.r - 0.4))
    })
    if (best) return (best as { pick: TownPick }).pick
    const byId = new Map(e.town.graph.nodes.map(n => [n.id, n]))
    for (const ed of e.town.graph.edges) {
      const a = byId.get(ed.a)!
      const b = byId.get(ed.b)!
      take({ kind: 'edge', a: ed.a, b: ed.b }, segDist(x, z, a.x, a.z, b.x, b.z), r * 0.6)
    }
    return best ? (best as { pick: TownPick }).pick : null
  }

  // ---- input -----------------------------------------------------------------------------------------------------

  /** Pointer events while the tool is on; true when the tool used it (the camera keeps right-drag). */
  pointer(pi: PointerInfo, ray: Ray, type: 'down' | 'up' | 'move'): boolean {
    if (!this.active || !this.edits) return false
    const ev = pi.event as PointerEvent
    const hit = this.host.groundHit(ray)
    if (type === 'down') {
      const pick = hit ? this.pickAt(hit.x, hit.z, hit.y) : null
      this.down = { x: ev.clientX, y: ev.clientY, pick, button: ev.button }
      if (ev.button !== 0) return false
      if (pick && (pick.kind === 'node' || pick.kind === 'seat' || pick.kind === 'row') && !(this.selection?.kind === 'node' && pick.kind === 'node' && this.selection.id !== pick.id)) {
        this.select(pick)
      }
      return true
    }
    if (type === 'move') {
      const d = this.down
      if (!d || d.button !== 0 || !d.pick || !hit) return false
      if (!this.drag && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 5) return true
      if (d.pick.kind !== 'node' && d.pick.kind !== 'seat' && d.pick.kind !== 'row') return true
      if (!samePick(this.selection, d.pick)) return true
      this.drag = { pick: d.pick, x: hit.x, z: hit.z }
      this.draw()
      this.host.invalidate()
      return true
    }
    // up
    const d = this.down
    this.down = null
    if (!d) return false
    const moved = Math.hypot(ev.clientX - d.x, ev.clientY - d.y) >= 5
    if (d.button === 2) {
      if (!moved && d.pick) this.remove(d.pick)
      return false
    }
    if (d.button !== 0) return false
    if (this.drag) {
      const g = this.drag
      this.drag = null
      this.commitDrag(g.pick, g.x, g.z)
      return true
    }
    if (moved) return true
    this.click(d.pick, hit, ev.shiftKey)
    return true
  }

  private click(pick: TownPick | null, hit: Vector3 | null, shift: boolean): void {
    const e = this.edits!
    const sel = this.selection
    if (pick?.kind === 'node' && sel?.kind === 'node' && sel.id !== pick.id) {
      if (!this.canChange()) return
      const why = e.addEdge(sel.id, pick.id)
      if (!why) this.selection = pick
      return this.changed(why ? null : 'Joined two path points', why)
    }
    if (pick) return this.select(pick), this.describe()
    if (!hit) return
    if (shift && (sel?.kind === 'place' || sel?.kind === 'seat')) {
      if (!this.canChange()) return
      const p = e.place(sel.kind === 'place' ? sel.id : sel.place)!
      const why = e.addSeat(p.id, hit.x, hit.z, Math.atan2(p.x - hit.x, p.z - hit.z), p.kind === 'bench' || p.kind === 'teaTable' ? 'chair' : p.kind === 'fountainRim' || p.kind === 'pondEdge' ? 'floor' : 'stand')
      if (!why) this.selection = { kind: 'seat', place: p.id, index: p.seats!.length - 1 }
      return this.changed(why ? null : `Added a seat to ${p.id}`, why)
    }
    if (shift || sel?.kind === 'node') {
      if (!this.canChange()) return
      const r = e.addNode(hit.x, hit.z, shift ? undefined : (sel as { id: string }).id)
      if (r.node) this.selection = { kind: 'node', id: r.node.id }
      return this.changed(r.node ? (shift ? 'Added a lone path point (click it, then another, to join them)' : 'Added a path point') : null, r.problem)
    }
    this.select(null)
    this.host.say('Routes: click a path point, a seat, a place or a town prop.')
  }

  private commitDrag(pick: TownPick, x: number, z: number): void {
    const e = this.edits!
    if (!this.canChange()) return this.draw()
    if (pick.kind === 'node') return this.changed('Moved a path point', e.moveNode(pick.id, x, z))
    if (pick.kind === 'seat') {
      const s = e.place(pick.place)?.seats?.[pick.index]
      if (!s) return
      return this.changed('Moved a seat', e.moveSeat(pick.place, pick.index, x, z, s.yaw))
    }
    if (pick.kind === 'row') {
      const r = e.row(pick.id)
      if (!r) return
      return this.changed(`Moved ${pick.id}`, e.moveRow(pick.id, x, z, r.yaw))
    }
  }

  private remove(pick: TownPick): void {
    const e = this.edits!
    if (!this.canChange()) return
    if (pick.kind === 'node') {
      e.removeNode(pick.id)
      this.selection = null
      return this.changed('Deleted a path point and its paths')
    }
    if (pick.kind === 'edge') {
      e.cutEdge(pick.a, pick.b)
      this.selection = null
      return this.changed('Deleted a path')
    }
    if (pick.kind === 'seat') {
      const why = e.removeSeat(pick.place, pick.index)
      if (!why) this.selection = null
      return this.changed(why ? null : 'Deleted a seat', why)
    }
    if (pick.kind === 'row') {
      if (!confirm(`Delete the town prop "${pick.id}"? (Undo brings it back.)`)) return
      e.removeRow(pick.id)
      this.selection = null
      return this.changed(`Deleted ${pick.id}`)
    }
    this.host.say('Places come from the map (a bench, a stall, the fountain): move or delete the prop, or its seats.', 'warn')
  }

  /** Keys while the tool is on; true when used. */
  key(e: KeyboardEvent): boolean {
    if (!this.active || !this.edits) return false
    const k = e.key.toLowerCase()
    if (e.ctrlKey && k === 'z') return e.preventDefault(), this.undo(), true
    if (e.ctrlKey && k === 'y') return e.preventDefault(), this.redo(), true
    if (e.ctrlKey || e.altKey) return false
    const sel = this.selection
    if (k === 'escape' && sel) return this.select(null), true
    if ((k === 'delete' || k === 'backspace') && sel) return this.remove(sel), true
    if ((k === ',' || k === '.') && sel && (sel.kind === 'seat' || sel.kind === 'row')) {
      if (!this.canChange()) return true
      const d = k === ',' ? -TURN : TURN
      if (sel.kind === 'seat') {
        const s = this.edits.place(sel.place)?.seats?.[sel.index]
        if (s) this.changed('Turned a seat', this.edits.moveSeat(sel.place, sel.index, s.x, s.z, s.yaw + d))
      } else {
        const r = this.edits.row(sel.id)
        if (r) this.changed(`Turned ${sel.id}`, this.edits.moveRow(sel.id, r.x, r.z, r.yaw + d))
      }
      return true
    }
    return false
  }

  // ---- save ------------------------------------------------------------------------------------------------------

  /** Saves the town files when they changed; null when nothing to do, else the outcome sentence (throws on refusal). */
  async save(): Promise<string | null> {
    const e = this.edits
    if (!e || !e.unsaved) return null
    if (this.readOnlyWhy) throw new Error(`The town changes can't be saved: ${this.readOnlyWhy}.`)
    const { files, problems } = e.payload()
    if (!files) throw new Error(`The town changes can't be saved yet: ${problems[0]}`)
    const res = await this.host.api.request('POST', 'town', { town: files.town, dressing: files.dressing ?? undefined, base: this.base } satisfies { town: unknown; dressing?: unknown; base: TownLoad['base'] })
    const body = (await res.json()) as { written?: string[]; base?: TownLoad['base']; error?: string }
    if (!res.ok || !body.base) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
    this.base = body.base
    e.markSaved()
    this.renderPanel()
    return `town routes and props saved (${townManualCount(files.town.manual)} hand edits in the overlay)`
  }

  // ---- drawing ---------------------------------------------------------------------------------------------------

  /** The overlay's lines (rebuilt after each change and while dragging). */
  draw(): void {
    this.mesh?.dispose()
    this.mesh = null
    const e = this.edits
    if (!this.active || !e) return this.host.invalidate()
    const lines: Vector3[][] = []
    const colors: Color4[][] = []
    const ground = (x: number, z: number, y?: number) => y ?? this.host.world.regions.heightAt(x, z) ?? 0
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: Color4) => {
      lines.push([new Vector3(ax, ay + LIFT_M, az), new Vector3(bx, by + LIFT_M, bz)])
      colors.push([c, c])
    }
    const ring = (x: number, y: number, z: number, r: number, c: Color4, n = 8) => {
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2
        const a1 = ((i + 1) / n) * Math.PI * 2
        seg(x + Math.sin(a0) * r, y, z + Math.cos(a0) * r, x + Math.sin(a1) * r, y, z + Math.cos(a1) * r, c)
      }
    }
    const sel = this.selection
    const drag = this.drag
    // node positions (a dragged node follows the cursor)
    const pos = new Map<string, { x: number; y: number; z: number }>()
    for (const n of e.town.graph.nodes) pos.set(n.id, { x: n.x, y: ground(n.x, n.z, n.y), z: n.z })
    if (drag?.pick.kind === 'node') pos.set(drag.pick.id, { x: drag.x, y: ground(drag.x, drag.z), z: drag.z })
    const hand = this.handKeys()
    for (const ed of e.town.graph.edges) {
      const a = pos.get(ed.a)
      const b = pos.get(ed.b)
      if (!a || !b) continue
      const isSel = sel?.kind === 'edge' && ((sel.a === ed.a && sel.b === ed.b) || (sel.a === ed.b && sel.b === ed.a))
      const c = isSel ? C.pick : e.problem(ed.a, ed.b) ? C.red : hand.edges.has(key(ed.a, ed.b)) ? C.hand : C.edge
      seg(a.x, a.y, a.z, b.x, b.y, b.z, c)
    }
    for (const n of e.town.graph.nodes) {
      const p = pos.get(n.id)!
      const isSel = sel?.kind === 'node' && sel.id === n.id
      const r = isSel ? 0.9 : 0.45
      const c = isSel ? C.pick : hand.nodes.has(n.id) ? C.hand : C.edge
      seg(p.x - r, p.y, p.z, p.x, p.y, p.z + r, c)
      seg(p.x, p.y, p.z + r, p.x + r, p.y, p.z, c)
      seg(p.x + r, p.y, p.z, p.x, p.y, p.z - r, c)
      seg(p.x, p.y, p.z - r, p.x - r, p.y, p.z, c)
    }
    for (const p of e.town.places) {
      const isSel = sel?.kind === 'place' && sel.id === p.id
      const py = ground(p.x, p.z, p.y)
      ring(p.x, py, p.z, isSel ? 0.9 : 0.6, isSel ? C.pick : C.place)
      const n = pos.get(p.node)
      if (n) seg(n.x, n.y, n.z, p.x, py, p.z, C.link)
      p.seats?.forEach((s, i) => {
        const on = sel?.kind === 'seat' && sel.place === p.id && sel.index === i
        const dragged = drag?.pick.kind === 'seat' && drag.pick.place === p.id && drag.pick.index === i
        const sx = dragged ? drag!.x : s.x
        const sz = dragged ? drag!.z : s.z
        const sy = ground(sx, sz, dragged ? undefined : s.y)
        const fx = Math.sin(s.yaw)
        const fz = Math.cos(s.yaw)
        const c = on ? C.pick : C.seat
        // a small arrow: the seat's facing
        seg(sx - fz * 0.25, sy, sz + fx * 0.25, sx + fx * 0.4, sy, sz + fz * 0.4, c)
        seg(sx + fz * 0.25, sy, sz - fx * 0.25, sx + fx * 0.4, sy, sz + fz * 0.4, c)
        seg(sx - fz * 0.25, sy, sz + fx * 0.25, sx + fz * 0.25, sy, sz - fx * 0.25, c)
      })
    }
    const rows = this.checker?.rowList ?? dressingRowsWith(e.dressing, this.host.world.manifest)
    const ids = e.rows().map(r => r.id ?? '')
    rows.forEach((row, i) => {
      const on = sel?.kind === 'row' && sel.id === ids[i]
      const dragged = drag?.pick.kind === 'row' && drag.pick.id === ids[i]
      const rx = dragged ? drag!.x : row.x
      const rz = dragged ? drag!.z : row.z
      const y = ground(rx, rz, dragged ? undefined : row.y)
      const c = on ? C.pick : C.row
      const cs = Math.cos(row.yaw)
      const sn = Math.sin(row.yaw)
      const corner = (lx: number, lz: number) => ({ x: rx + lx * cs + lz * sn, z: rz - lx * sn + lz * cs })
      const k = [corner(row.min[0], row.min[2]), corner(row.max[0], row.min[2]), corner(row.max[0], row.max[2]), corner(row.min[0], row.max[2])]
      for (let j = 0; j < 4; j++) seg(k[j]!.x, y, k[j]!.z, k[(j + 1) % 4]!.x, y, k[(j + 1) % 4]!.z, c)
    })
    if (lines.length) {
      this.mesh = MeshBuilder.CreateLineSystem('editorTownRoutes', { lines, colors }, this.host.scene) as LinesMesh
      this.mesh.isPickable = false
      this.mesh.renderingGroupId = 1
    }
    this.host.invalidate()
  }

  /** Which nodes and edges are the user's (gold): the overlay's added nodes, moved nodes and added edges. */
  private handKeys(): { nodes: Set<string>; edges: Set<string> } {
    const e = this.edits!
    const m = e.log.manual
    const nodes = new Set<string>()
    const at = (x: number, z: number) => e.town.graph.nodes.find(n => Math.abs(n.x - x) < 0.011 && Math.abs(n.z - z) < 0.011)
    for (const n of m.nodes ?? []) nodes.add(n.id)
    for (const mv of m.moved ?? []) {
      const n = at(mv.x, mv.z)
      if (n) nodes.add(n.id)
    }
    const edges = new Set<string>()
    for (const ed of m.edges ?? []) {
      const a = at(ed.a[0], ed.a[1])
      const b = at(ed.b[0], ed.b[1])
      if (a && b) edges.add(key(a.id, b.id))
    }
    return { nodes, edges }
  }

  // ---- the side panel --------------------------------------------------------------------------------------------

  private ensurePanel(): void {
    if (this.panel) return
    const side = document.getElementById('side')
    if (!side) return
    const s = document.createElement('section')
    s.id = 'townRoutes'
    s.className = 'hidden'
    s.innerHTML = '<h3>Town routes <small id="townCount"></small></h3><div id="townSel" class="muted"></div><div class="row" style="margin-top: 6px"><button id="townDel" title="Delete what is picked (Del)">Delete</button><button id="townUndo" title="Undo the last town change (Ctrl+Z)">Undo</button><button id="townRedo" title="Redo (Ctrl+Y)">Redo</button></div><div id="townNote" class="muted" style="margin-top: 6px"></div>'
    side.insertBefore(s, side.firstChild)
    this.panel = s
    ;(s.querySelector('#townDel') as HTMLButtonElement).onclick = () => this.selection && this.remove(this.selection)
    ;(s.querySelector('#townUndo') as HTMLButtonElement).onclick = () => this.undo()
    ;(s.querySelector('#townRedo') as HTMLButtonElement).onclick = () => this.redo()
  }

  private describe(): void {
    const sel = this.selection
    const e = this.edits
    if (!sel || !e) return
    if (sel.kind === 'node') this.host.say('Path point picked: click another point to join them, open ground for a new point, drag to move it, Del to delete it.')
    else if (sel.kind === 'seat') this.host.say('Seat picked: drag to move it, , and . turn it, Del deletes it.')
    else if (sel.kind === 'row') this.host.say(`Town prop ${sel.id} picked: drag to move it (its seats go along), , and . turn it, Del deletes it.`)
    else if (sel.kind === 'place') this.host.say('Place picked: Shift+click by it adds a seat facing it.')
    else this.host.say('Path picked: Del (or a right-click) deletes it.')
  }

  private renderPanel(): void {
    const e = this.edits
    if (!this.panel || !e) return
    const q = (id: string) => this.panel!.querySelector(`#${id}`) as HTMLElement
    const n = e.manualCount
    q('townCount').textContent = `${n} hand edit${n === 1 ? '' : 's'}`
    const sel = this.selection
    let text = 'Nothing picked. Click a path point, a seat, a place or a town prop.'
    if (sel?.kind === 'node') {
      const node = e.node(sel.id)
      const deg = e.town.graph.edges.filter(x => x.a === sel.id || x.b === sel.id).length
      if (node) text = `Path point ${sel.id} at ${node.x.toFixed(1)}, ${node.z.toFixed(1)}: ${deg} path${deg === 1 ? '' : 's'}.`
    } else if (sel?.kind === 'seat') {
      const p = e.place(sel.place)
      text = `Seat ${sel.index + 1} of ${p?.id ?? '?'} (${p?.kind ?? ''}), ${p?.seats?.[sel.index]?.pose ?? ''}.`
    } else if (sel?.kind === 'place') {
      const p = e.place(sel.id)
      text = `${p?.kind ?? 'Place'} ${sel.id}: ${p?.seats?.length ?? 0} seat(s). Shift+click by it adds one.`
    } else if (sel?.kind === 'row') {
      const r = e.row(sel.id)
      text = `Town prop ${sel.id} (${r ? townBaseName(r.model) : '?'})${this.rowPlacements.has(sel.id) ? '' : ': not on this export\'s map yet (it shows after Publish)'}.`
    } else if (sel?.kind === 'edge') text = `Path ${sel.a} - ${sel.b}${e.problem(sel.a, sel.b) ? `: red, ${e.problem(sel.a, sel.b)}` : ''}.`
    q('townSel').textContent = text
    const red = e.redEdges().length
    q('townNote').textContent = [
      this.readOnlyWhy ? `Not saved: ${this.readOnlyWhy}.` : e.unsaved ? `${e.unsaved} unsaved town change${e.unsaved === 1 ? '' : 's'} (Save keeps them).` : '',
      red ? `${red} red path${red === 1 ? '' : 's'}: Save waits until they are fixed.` : '',
      'A rebuild of the routes (Publish runs one) keeps every hand edit.',
    ].filter(Boolean).join(' ')
    ;(q('townUndo') as HTMLButtonElement).disabled = !e.canUndo
    ;(q('townRedo') as HTMLButtonElement).disabled = !e.canRedo
    ;(q('townDel') as HTMLButtonElement).disabled = !sel || sel.kind === 'place'
  }

  /** The tool's files for a check (tests, the debug hook). */
  files(): TownFiles | null {
    return this.edits ? { town: this.edits.town, dressing: this.edits.dressing } : null
  }

  dispose(): void {
    this.mesh?.dispose()
    this.mesh = null
  }
}

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const l2 = dx * dx + dz * dz
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz))
}
