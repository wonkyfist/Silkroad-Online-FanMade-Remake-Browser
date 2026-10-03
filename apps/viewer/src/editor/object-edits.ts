/**
 * Object edits (docs/WORLD_EDITOR.md §3.2, §4.5, §4.6, D10-D12, D17, D27, D28): moves, turns, scales and deletes of
 * the export's placements, and new placements ("adds"), as one state the editor previews and `placements.json`
 * saves. The preview runs the shared `lowerPlacementEdits` (the converter's own lowering: a move is a drop + an add,
 * an add takes the lowest free editor uid 0xE000-0xEFFF of its owner region), so the region lists the editor batches
 * are the lists the export will hold.
 *
 * An object is a ref: `r:<region>:<uid>` (a retail placement, addressed by its owner key) or `a:<id>` (an add,
 * `ed-<n>`). A change lists every ref it touched with its state before and after (null: absent), so undo, redo and
 * "revert this one change" are plain assignments.
 */
import {
  WE_EDITOR_UID_MAX, WE_EDITOR_UID_MIN, WE_PROP_SCALE, WE_TREE_SCALE, WORLD_EDITS_PLACEMENTS_FORMAT, WORLD_EDITS_VERSION,
  lowerPlacementEdits, yawRotation,
  type WorldEditAdd, type WorldEditModelKind, type WorldEditPlacementsFile,
} from '../../../../packages/shared/src/world-edits/index.ts'
import type { WorldPlacement } from '../../../../packages/convert/src/world/manifest.ts'

export type Vec3 = [number, number, number]

export interface ObjState {
  source: string
  position: Vec3
  /** Radians, file space (WorldPlacement.yaw). */
  yaw: number
  /** Uniform; 1 = unscaled. */
  scale: number
}

export type ObjRef = string

export interface ObjectChangeItem {
  ref: ObjRef
  before: ObjState | null
  after: ObjState | null
}

export interface ObjectChangeData {
  items: ObjectChangeItem[]
}

export const retailRef = (region: number, uid: number): ObjRef => `r:${region}:${uid}`
/** The town dressing's first uid (packages/convert/src/world/uids.ts): its props are edited by row, never by uid. */
export const DRESSING_UID_FIRST = 1_000_000
/** True for a town dressing prop's ref (edited with the Routes tool by its row; placements.json never holds it). */
export const isDressingRef = (ref: ObjRef) => ref.startsWith('r:') && Number(ref.slice(ref.lastIndexOf(':') + 1)) >= DRESSING_UID_FIRST
export const addRef = (id: string): ObjRef => `a:${id}`
export const isAddRef = (ref: ObjRef) => ref.startsWith('a:')

/** Positions round to 0.1 mm and yaws to 1 µrad when a change is made: the saved file holds exactly the preview. */
export function roundState(s: ObjState): ObjState {
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6
  return { source: s.source, position: [r4(s.position[0]), r4(s.position[1]), r4(s.position[2])], yaw: r6(normYaw(s.yaw)), scale: r4(s.scale) }
}

/** A yaw in (-pi, pi]. */
export function normYaw(y: number): number {
  let a = y % (Math.PI * 2)
  if (a > Math.PI) a -= Math.PI * 2
  if (a <= -Math.PI) a += Math.PI * 2
  return a
}

export const sameState = (a: ObjState | null, b: ObjState | null): boolean =>
  a === b || (!!a && !!b && a.source === b.source && a.position[0] === b.position[0] && a.position[1] === b.position[1] && a.position[2] === b.position[2] && a.yaw === b.yaw && a.scale === b.scale)

/** The scale range of a model kind (D12, D17): trees 0.85-1.15, footprint-free props 0.5-2, never a blocker. */
export function scaleRange(kind: WorldEditModelKind): readonly [number, number] {
  return kind === 'tree' ? WE_TREE_SCALE : kind === 'prop' ? WE_PROP_SCALE : [1, 1]
}

export const clampScale = (s: number, kind: WorldEditModelKind) => {
  const [lo, hi] = scaleRange(kind)
  return Math.min(hi, Math.max(lo, s))
}

export class ObjectEdits {
  private readonly retail = new Map<ObjRef, WorldPlacement>()
  private readonly templates = new Map<string, WorldPlacement>()
  /** Retail overrides: a state, or null (dropped). */
  private readonly overrides = new Map<ObjRef, ObjState | null>()
  private readonly adds = new Map<ObjRef, ObjState>()
  /**
   * The `source` / `from` placements.json recorded for a retail edit whose export placement changed since (a
   * re-export, a coast re-run): kept as they were, so the converter and Publish still say "the object changed under
   * your edit" until the user reverts the edit (H-12 DL-4).
   */
  private readonly stale = new Map<ObjRef, { source: string; from: { position: Vec3; yaw: number } }>()
  private nextAdd = 1
  /** Bumped on every change (the editor re-lowers when it moved). */
  version = 0

  constructor(readonly placements: readonly WorldPlacement[], readonly originRegion: { x: number; z: number }, readonly world: string) {
    for (const p of placements) {
      this.retail.set(retailRef(p.region, p.uid), p)
      const k = p.source.toLowerCase()
      if (!this.templates.has(k)) this.templates.set(k, p)
    }
  }

  /** The export's placement of a retail ref. */
  placementOf(ref: ObjRef): WorldPlacement | undefined {
    return this.retail.get(ref)
  }

  /** A placement of the same model source (the add's template: models, objId, flags, group), or undefined. */
  templateOf(source: string): WorldPlacement | undefined {
    return this.templates.get(source.toLowerCase())
  }

  /** The export's state of a ref (adds: null). */
  original(ref: ObjRef): ObjState | null {
    const p = this.retail.get(ref)
    return p ? { source: p.source, position: [p.position[0], p.position[1], p.position[2]], yaw: p.yaw, scale: p.scale ?? 1 } : null
  }

  /** The current state of a ref (null: deleted, or unknown). */
  current(ref: ObjRef): ObjState | null {
    if (isAddRef(ref)) return this.adds.get(ref) ?? null
    if (this.overrides.has(ref)) return this.overrides.get(ref)!
    return this.original(ref)
  }

  /** Whether a retail ref is edited (moved, turned, scaled or deleted). */
  edited(ref: ObjRef): boolean {
    return isAddRef(ref) ? this.adds.has(ref) : this.overrides.has(ref)
  }

  /**
   * Sets a ref's state (null: delete / remove the add). A retail state equal to the export's drops the override. A
   * town dressing ref is refused (H-12 PS-6: its rows are the town's, a uid in placements.json stops Publish).
   */
  set(ref: ObjRef, s: ObjState | null): void {
    if (isDressingRef(ref)) return
    this.version++
    if (isAddRef(ref)) {
      if (s) this.adds.set(ref, s)
      else this.adds.delete(ref)
      const n = Number(ref.slice(5))
      if (Number.isInteger(n) && n >= this.nextAdd) this.nextAdd = n + 1
      return
    }
    if (sameState(s, this.original(ref))) {
      this.overrides.delete(ref)
      this.stale.delete(ref)
    } else this.overrides.set(ref, s)
  }

  /** A fresh add ref (ed-<n>). */
  newAddRef(): ObjRef {
    return addRef(`ed-${this.nextAdd++}`)
  }

  /** Applies a change's 'before' (undo) or 'after' (redo). */
  apply(c: ObjectChangeData, which: 'before' | 'after'): void {
    for (const it of c.items) this.set(it.ref, which === 'before' ? it.before : it.after)
  }


  /** The retail edits whose export object changed under them since they were saved (DL-4). */
  changedUnder(): ObjRef[] {
    return [...this.stale.keys()].filter(r => this.overrides.has(r))
  }

  /** Every edited ref (retail overrides and adds). */
  editedRefs(): ObjRef[] {
    return [...this.overrides.keys(), ...this.adds.keys()]
  }

  /**
   * The current objects near glTF (x, z) within `r` metres (deleted ones left out). The town dressing only with
   * `dressing` (the click path, which routes it to its row; a box selection never takes it: PS-6).
   */
  *near(x: number, z: number, r: number, dressing = false): Generator<{ ref: ObjRef; state: ObjState; placement: WorldPlacement | undefined }> {
    const r2 = r * r
    for (const [ref, p] of this.retail) {
      if (!dressing && p.uid >= DRESSING_UID_FIRST) continue
      const s = this.overrides.has(ref) ? this.overrides.get(ref)! : null
      const pos = s ? s.position : p.position
      if (this.overrides.has(ref) && !s) continue
      const dx = pos[0] - x, dz = pos[2] - z
      if (dx * dx + dz * dz > r2) continue
      yield { ref, state: s ?? this.original(ref)!, placement: p }
    }
    for (const [ref, s] of this.adds) {
      const dx = s.position[0] - x, dz = s.position[2] - z
      if (dx * dx + dz * dz > r2) continue
      yield { ref, state: s, placement: this.templateOf(s.source) }
    }
  }

  /** The deleted retail objects (for "Show deleted" and revert). */
  deleted(): Array<{ ref: ObjRef; state: ObjState }> {
    const out: Array<{ ref: ObjRef; state: ObjState }> = []
    for (const [ref, s] of this.overrides) if (!s) out.push({ ref, state: this.original(ref)! })
    return out
  }

  // ---- placements.json ----------------------------------------------------------------------------------------------

  /** The edits as placements.json (moves, drops, adds; ordered by key for stable diffs). */
  toFile(): WorldEditPlacementsFile {
    const move: WorldEditPlacementsFile['move'] = []
    const drop: WorldEditPlacementsFile['drop'] = []
    const keys = [...this.overrides.keys()].sort(compareRefs)
    for (const ref of keys) {
      const p = this.retail.get(ref)
      if (!p) continue
      const s = this.overrides.get(ref)!
      const old = this.stale.get(ref)
      const source = old?.source ?? p.source
      const from = old ? { position: [...old.from.position] as Vec3, yaw: old.from.yaw } : { position: [p.position[0], p.position[1], p.position[2]] as Vec3, yaw: p.yaw }
      if (!s) drop.push({ region: p.region, uid: p.uid, source, from })
      else move.push({ region: p.region, uid: p.uid, source, from, to: { position: s.position, yaw: s.yaw, ...(s.scale !== 1 ? { scale: s.scale } : {}) } })
    }
    const add: WorldEditAdd[] = [...this.adds].sort((a, b) => compareRefs(a[0], b[0])).map(([ref, s]) => ({
      id: ref.slice(2), source: s.source, position: s.position, yaw: s.yaw, ...(s.scale !== 1 ? { scale: s.scale } : {}),
    }))
    return { format: WORLD_EDITS_PLACEMENTS_FORMAT, version: WORLD_EDITS_VERSION, world: this.world, move, drop, add }
  }

  /** Loads placements.json (the editor's start); unknown keys are kept out and reported. */
  loadFile(file: Pick<WorldEditPlacementsFile, 'move' | 'drop' | 'add'>): string[] {
    const problems: string[] = []
    // DL-4: an edit whose object changed in the export since it was saved is reported and keeps its recorded
    // source / from (never silently re-based onto whatever object now has that uid)
    const check = (what: string, ref: ObjRef, e: { region: number; uid: number; source: string; from?: { position: readonly number[]; yaw: number } }) => {
      const p = this.retail.get(ref)!
      const moved = !!e.from && (Math.hypot(e.from.position[0]! - p.position[0], e.from.position[2]! - p.position[2]) > 0.05 ||
        Math.abs(e.from.position[1]! - p.position[1]) > 0.05 || Math.abs(normYaw(e.from.yaw - p.yaw)) > 1e-3)
      const swapped = e.source.toLowerCase() !== p.source.toLowerCase()
      if (!moved && !swapped) return
      const from = e.from ?? { position: p.position, yaw: p.yaw }
      this.stale.set(ref, { source: e.source, from: { position: [from.position[0]!, from.position[1]!, from.position[2]!], yaw: from.yaw } })
      problems.push(`${what} ${e.region}:${e.uid}: the object changed under your edit (the map now has ${p.source.split(/[\\/]/).pop()} ${swapped ? 'there' : 'moved'}); check it, then revert the edit and make it again`)
    }
    for (const m of file.move) {
      const ref = retailRef(m.region, m.uid)
      if (!this.retail.has(ref)) problems.push(`move ${m.region}:${m.uid}: not in this export`)
      else {
        this.set(ref, { source: m.source, position: [...m.to.position] as Vec3, yaw: m.to.yaw, scale: m.to.scale ?? 1 })
        check('move', ref, m)
      }
    }
    for (const d of file.drop) {
      const ref = retailRef(d.region, d.uid)
      if (!this.retail.has(ref)) problems.push(`drop ${d.region}:${d.uid}: not in this export`)
      else {
        this.set(ref, null)
        check('drop', ref, d)
      }
    }
    for (const a of file.add) this.set(addRef(a.id), { source: a.source, position: [...a.position] as Vec3, yaw: a.yaw, scale: a.scale ?? 1 })
    return problems
  }

  // ---- the preview: lowered region lists ----------------------------------------------------------------------------

  /**
   * The placement lists of every region the edits touch (old and new homes), as the converter will write them:
   * `lowerPlacementEdits` on the export's list; an add copies a placement of the same model (its template). `homeOf`:
   * the region a placement is streamed with (stream.ts `regionInfos`: its owner when exported, else by position);
   * default its owner.
   */
  lower(homeOf: (p: WorldPlacement) => number = p => p.region): { regions: Map<number, WorldPlacement[]>; problems: string[]; keyOf: Map<ObjRef, string> } {
    const lowered = lowerPlacementEdits(this.placements, this.toFile(), {
      originRegion: this.originRegion,
      create: (add, region, uid) => {
        const t = this.templateOf(add.source)
        if (!t) return null
        const p: WorldPlacement = {
          ...t, region, uid, position: [add.position[0], add.position[1], add.position[2]], rotation: yawRotation(add.yaw), yaw: add.yaw,
          inConvertedRegion: true,
        }
        delete p.scale
        if (add.scale !== undefined && add.scale !== 1) p.scale = add.scale
        return p
      },
    })
    const dropped = new Set(lowered.drop.map(d => `${d.region}:${d.uid}`))
    const touched = new Set<number>()
    for (const d of lowered.drop) {
      const p = this.retail.get(retailRef(d.region, d.uid))
      if (p) touched.add(homeOf(p))
    }
    for (const p of lowered.add) touched.add(homeOf(p))
    const regions = new Map<number, WorldPlacement[]>()
    for (const id of touched) regions.set(id, [])
    for (const p of this.placements) {
      if (dropped.has(`${p.region}:${p.uid}`)) continue
      regions.get(homeOf(p))?.push(p)
    }
    for (const p of lowered.add) regions.get(homeOf(p))!.push(p)
    // where each edited ref ended up (its owner key now): moves by their old key, adds by id
    const keyOf = new Map<ObjRef, string>()
    for (const a of lowered.assigned) keyOf.set(a.kind === 'move' ? `r:${a.key}` : addRef(a.key), `${a.region}:${a.uid}`)
    return { regions, problems: lowered.problems, keyOf }
  }
}

function compareRefs(a: ObjRef, b: ObjRef): number {
  const pa = a.split(':'), pb = b.split(':')
  if (pa[0] !== pb[0]) return pa[0]! < pb[0]! ? -1 : 1
  if (pa[0] === 'a') return Number(pa[1]!.slice(3)) - Number(pb[1]!.slice(3)) || (pa[1]! < pb[1]! ? -1 : pa[1]! > pb[1]! ? 1 : 0)
  return Number(pa[1]) - Number(pb[1]) || Number(pa[2]) - Number(pb[2])
}

/** The editor uid range, for the status line ("4,096 editor objects per region"). */
export const EDITOR_UIDS_PER_REGION = WE_EDITOR_UID_MAX - WE_EDITOR_UID_MIN + 1
