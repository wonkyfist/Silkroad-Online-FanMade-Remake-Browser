/**
 * The edit journal (docs/WORLD_EDITOR.md §3.4, D16, D17): every user action is one change (a brush stroke, one move /
 * turn / scale / snap, one paste, one delete, one region revert), recording its own difference. Undo / redo
 * (Ctrl+Z / Ctrl+Y) walk it and are bit-exact; "revert this change" subtracts that change's own difference from the
 * current state, so later changes on top stay; reverting it again re-applies it.
 *
 * The journal holds at most JOURNAL_CAP changes and JOURNAL_CAP_BYTES of records; the oldest fold into the saved
 * state (still revertable per region).
 * `encodeChange` / `decodeChange` give the JSON the editor API keeps in `work/editor/<world>/journal.ndjson`.
 */
import type { GrassChangeData } from './grass-edits.ts'
import type { ObjectChangeData, ObjState } from './object-edits.ts'
import type { PaintChangeData } from './paint-edits.ts'
import type { HeightChangeData } from './terrain-edits.ts'
import type { WalkChangeData } from './walk-edits.ts'

export const JOURNAL_CAP = 2000
/**
 * The page journal's byte cap (its records as Save sends them): every Save posts every record, so the journal must
 * fold well before a Save passes the API's body limit (protocol.ts MAX_BODY_BYTES 128 MB; H-12 DL-3). The rest of the
 * body is the touched layers.
 */
export const JOURNAL_CAP_BYTES = 64 * 1024 * 1024

const b64Bytes = (a: { byteLength: number } | undefined) => (a ? Math.ceil(a.byteLength / 3) * 4 : 0)

/** About how many bytes a change takes in a Save (its encodeChange JSON): the base64 arrays plus a small rest. */
export function changeBytes(c: ChangeParts & { label?: string }): number {
  let n = 512 + (c.label?.length ?? 0)
  for (const part of [c.height, c.paint, c.grass, c.walk]) if (part) n += b64Bytes(part.keys) + b64Bytes(part.before) + b64Bytes(part.after) + 256
  if (c.objects) n += JSON.stringify(c.objects).length
  return n
}

export type ChangeState = 'done' | 'undone' | 'reverted'

export interface ChangeParts {
  height?: HeightChangeData
  paint?: PaintChangeData
  grass?: GrassChangeData
  objects?: ObjectChangeData
  walk?: WalkChangeData
}

export interface Change extends ChangeParts {
  id: number
  /** ISO time. */
  at: string
  /** Plain English ("Raised the ground in region 171,97 by up to 2.30 m"). */
  label: string
  state: ChangeState
  /** Regions it touched (for "revert this region" and the minimap). */
  regions: number[]
  /** The camera when it was made (position xyz, target xyz): Publish's before / after views, "look at it". */
  view?: number[]
  /** The user starred its view for the before / after sheet. */
  starred?: boolean
}

/** What applies a change's parts to the live state (the four edit models, plus the editor's refresh). */
export interface ChangeTarget {
  /** Undo ('before') or redo ('after') the newest change: exact. */
  apply(parts: ChangeParts, which: 'before' | 'after'): void
  /**
   * Revert (-1) or re-apply (+1) one change out of order. `later`: the changes after it still in the chain (done or
   * undone, oldest first): where one of them wrote the same key later, its own `before` is rebased instead of the
   * live value, so its undo later lands on the right value.
   */
  toggle(parts: ChangeParts, sign: 1 | -1, later: readonly Change[]): void
}

export class History {
  readonly changes: Change[] = []
  private readonly redoStack: Change[] = []
  private serial = 0
  /** Changes folded out of the journal (the cap). */
  folded = 0
  /** The journal's records' size as Save sends them (changeBytes). */
  bytes = 0
  private readonly sizes = new WeakMap<Change, number>()

  constructor(private readonly target: ChangeTarget) {}

  /** The next change id (Noise seeds its stroke with it). */
  peekId(): number {
    return this.serial + 1
  }

  /** Records a change already applied to the state. Clears the redo stack (its changes leave the journal). */
  push(parts: ChangeParts, label: string, regions: number[], at = new Date().toISOString()): Change {
    for (const c of this.redoStack.splice(0)) {
      const i = this.changes.indexOf(c)
      if (i >= 0) {
        this.changes.splice(i, 1)
        this.bytes -= this.sizeOf(c)
      }
    }
    const c: Change = { id: ++this.serial, at, label, state: 'done', regions, ...parts }
    this.add(c)
    this.fold()
    return c
  }

  private sizeOf(c: Change): number {
    let n = this.sizes.get(c)
    if (n === undefined) {
      n = changeBytes(c)
      this.sizes.set(c, n)
    }
    return n
  }

  private add(c: Change): void {
    this.changes.push(c)
    this.bytes += this.sizeOf(c)
  }

  /** Folds the oldest changes past the count or the byte cap (the newest always stays). */
  private fold(): void {
    while (this.changes.length > 1 && (this.changes.length > JOURNAL_CAP || this.bytes > JOURNAL_CAP_BYTES)) {
      const c = this.changes.shift()!
      this.bytes -= this.sizeOf(c)
      const r = this.redoStack.indexOf(c)
      if (r >= 0) this.redoStack.splice(r, 1)
      this.folded++
    }
  }

  /** Re-inserts journal entries (the editor's start): their effects are already in the loaded layers. */
  restore(entries: readonly Change[]): void {
    for (const e of entries) {
      this.add(e)
      this.serial = Math.max(this.serial, e.id)
    }
    this.fold()
    // the redo stack pops the oldest undone change first (undo pushed the newest first)
    for (let i = this.changes.length - 1; i >= 0; i--) if (this.changes[i]!.state === 'undone') this.redoStack.push(this.changes[i]!)
  }

  get canUndo(): boolean {
    return this.changes.some(c => c.state === 'done')
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Undoes the newest change still in effect; null when there is none. */
  undo(): Change | null {
    for (let i = this.changes.length - 1; i >= 0; i--) {
      const c = this.changes[i]!
      if (c.state !== 'done') continue
      this.target.apply(c, 'before')
      c.state = 'undone'
      this.redoStack.push(c)
      return c
    }
    return null
  }

  redo(): Change | null {
    const c = this.redoStack.pop()
    if (!c) return null
    this.target.apply(c, 'after')
    c.state = 'done'
    return c
  }

  /**
   * "Revert this one change": subtracts its difference from the current state (later changes stay); on a reverted
   * change, re-applies it. An undone change is redone in place of the redo stack's order.
   */
  toggle(id: number): Change | null {
    const c = this.changes.find(x => x.id === id)
    if (!c) return null
    const later = this.changes.slice(this.changes.indexOf(c) + 1).filter(x => x.state !== 'reverted')
    if (c.state === 'done') {
      this.target.toggle(c, -1, later)
      c.state = 'reverted'
    } else {
      this.target.toggle(c, 1, later)
      c.state = 'done'
      const i = this.redoStack.indexOf(c)
      if (i >= 0) this.redoStack.splice(i, 1)
    }
    return c
  }

  /** Later changes still in effect that touch an object this change touched (reverting it first asks, §3.4). */
  dependants(id: number): Change[] {
    const c = this.changes.find(x => x.id === id)
    if (!c?.objects) return []
    const refs = new Set(c.objects.items.map(i => i.ref))
    return this.changes.filter(x => x.id > id && x.state === 'done' && x.objects?.items.some(i => refs.has(i.ref)))
  }

  /** Every change touching a region, newest first. */
  ofRegion(region: number): Change[] {
    return this.changes.filter(c => c.regions.includes(region)).reverse()
  }
}

// ---- plain-English labels ---------------------------------------------------------------------------------------------

export const regionName = (id: number) => `${id & 0xff},${id >> 8}`
export const regionList = (ids: readonly number[]) =>
  ids.length <= 3 ? ids.map(regionName).join(' and ') : `${ids.slice(0, 2).map(regionName).join(', ')} and ${ids.length - 2} more`

export const shortName = (source: string) => source.split(/[\\/]/).pop()!.replace(/\.(bsr|cpd)$/i, '')

const displayNames = new Map<string, string>()

/** The plain names of model sources the labels use (the library's: a new tree's species name for its carrier). */
export function setDisplayNames(entries: Iterable<readonly [string, string]>): void {
  displayNames.clear()
  for (const [source, name] of entries) displayNames.set(source.toLowerCase(), name)
}

/** A model's name in labels and sentences: the library's plain name ("Maple"), else its file stem. */
export const displayName = (source: string) => displayNames.get(source.toLowerCase()) ?? shortName(source)

const HEIGHT_VERBS = { raise: 'Raised the ground', lower: 'Lowered the ground', smooth: 'Smoothed the ground', flatten: 'Flattened the ground', noise: 'Roughened the ground' }

export function heightLabel(tool: keyof typeof HEIGHT_VERBS, c: HeightChangeData): string {
  const amount = tool === 'raise' ? `up to ${c.maxUp.toFixed(2)} m` : tool === 'lower' ? `up to ${(-c.maxDown).toFixed(2)} m` : `changes up to ${c.maxAbs.toFixed(2)} m`
  return `${HEIGHT_VERBS[tool]} in ${regionList(c.regions)} (${amount}, ${c.keys.length.toLocaleString('en-US')} points)`
}

export function paintLabel(tileName: string | null, c: PaintChangeData): string {
  return tileName
    ? `Painted ${tileName} in ${regionList(c.regions)} (${c.keys.length.toLocaleString('en-US')} points)`
    : `Brought back the original ground texture in ${regionList(c.regions)} (${c.keys.length.toLocaleString('en-US')} points)`
}

export function grassLabel(c: GrassChangeData): string {
  const what = c.mode === 'less' ? 'Thinned the grass' : c.mode === 'more' ? 'Thickened the grass' : c.mode === 'flowers' ? 'Planted flowers' : 'Brought back the original grass'
  return `${what} in ${regionList(c.regions)} (${c.keys.length.toLocaleString('en-US')} m²)`
}

export function walkLabel(c: WalkChangeData): string {
  const what = c.mode === 'open' ? 'Opened ground for walking' : c.mode === 'close' ? 'Closed ground for walking' : 'Gave ground back to the automatic walking rule'
  const n = c.keys.length
  return `${what} in ${regionList(c.regions)} (${n.toLocaleString('en-US')} tile${n === 1 ? '' : 's'})`
}

/** "Moved stone_field03 12.4 m, turned +40°", "Deleted 3 objects", "Placed tre_tree01"... */
export function objectLabel(verb: string, c: ObjectChangeData): string {
  const items = c.items
  if (!items.length) return verb
  const names = [...new Set(items.map(i => displayName((i.after ?? i.before)!.source)))]
  const what = items.length === 1 ? names[0]! : names.length === 1 ? `${items.length} × ${names[0]}` : `${items.length} objects`
  if (items.length === 1 && items[0]!.before && items[0]!.after) {
    const d = moveText(items[0]!.before, items[0]!.after)
    return d ? `${verb} ${what} ${d}` : `${verb} ${what}`
  }
  return `${verb} ${what}`
}

export function moveText(a: ObjState, b: ObjState): string {
  const d = Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2])
  const dy = ((((b.yaw - a.yaw) * 180) / Math.PI + 540) % 360) - 180
  const parts: string[] = []
  if (d > 0.05) parts.push(`${d.toFixed(1)} m`)
  if (Math.abs(dy) > 0.5) parts.push(`${dy > 0 ? '+' : ''}${dy.toFixed(0)}°`)
  if (Math.abs(b.scale - a.scale) > 1e-4) parts.push(`to ${Math.round(b.scale * 100)} % size`)
  const up = b.position[1] - a.position[1]
  if (Math.abs(up) > 0.05 && d <= 0.05) parts.push(`${Math.abs(up).toFixed(2)} m ${up > 0 ? 'up' : 'down'}`)
  return parts.join(', ')
}

// ---- journal JSON -------------------------------------------------------------------------------------------------------

type Typed = Float64Array | Int32Array | Uint32Array | Uint8Array

function b64(a: Typed): string {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}

function unb64<T extends Typed>(s: string, make: (b: ArrayBuffer) => T): T {
  const bin = atob(s)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return make(u8.buffer)
}

/** A change as one JSON object (typed arrays as base64, little-endian as the browser's). */
export function encodeChange(c: Change): Record<string, unknown> {
  const out: Record<string, unknown> = { id: c.id, at: c.at, label: c.label, state: c.state, regions: c.regions }
  if (c.view) out.view = c.view
  if (c.starred) out.starred = true
  if (c.height) out.height = { ...c.height, keys: b64(c.height.keys), before: b64(c.height.before), after: b64(c.height.after) }
  if (c.paint) out.paint = { ...c.paint, keys: b64(c.paint.keys), before: b64(c.paint.before), after: b64(c.paint.after) }
  if (c.grass) out.grass = { ...c.grass, keys: b64(c.grass.keys), before: b64(c.grass.before), after: b64(c.grass.after) }
  if (c.objects) out.objects = c.objects
  if (c.walk) out.walk = { ...c.walk, keys: b64(c.walk.keys), before: b64(c.walk.before), after: b64(c.walk.after) }
  return out
}

export function decodeChange(j: Record<string, unknown>): Change {
  const c: Change = { id: j.id as number, at: j.at as string, label: j.label as string, state: j.state as ChangeState, regions: j.regions as number[] }
  if (Array.isArray(j.view) && j.view.length === 6 && j.view.every(v => typeof v === 'number' && Number.isFinite(v))) c.view = j.view as number[]
  if (j.starred === true) c.starred = true
  const f64 = (s: unknown) => unb64(s as string, b => new Float64Array(b))
  const i32 = (s: unknown) => unb64(s as string, b => new Int32Array(b))
  const u32 = (s: unknown) => unb64(s as string, b => new Uint32Array(b))
  if (j.height) {
    const h = j.height as Record<string, unknown>
    c.height = { ...(h as unknown as HeightChangeData), keys: f64(h.keys), before: f64(h.before), after: f64(h.after) }
  }
  if (j.paint) {
    const p = j.paint as Record<string, unknown>
    c.paint = { ...(p as unknown as PaintChangeData), keys: f64(p.keys), before: i32(p.before), after: i32(p.after) }
  }
  if (j.grass) {
    const g = j.grass as Record<string, unknown>
    c.grass = { ...(g as unknown as GrassChangeData), keys: f64(g.keys), before: u32(g.before), after: u32(g.after) }
  }
  if (j.objects) c.objects = j.objects as ObjectChangeData
  if (j.walk) {
    const w = j.walk as Record<string, unknown>
    const u8 = (s: unknown) => unb64(s as string, b => new Uint8Array(b))
    c.walk = { ...(w as unknown as WalkChangeData), keys: f64(w.keys), before: u8(w.before), after: u8(w.after) }
  }
  return c
}
