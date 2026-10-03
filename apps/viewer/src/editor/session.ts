/**
 * One editing session (docs/WORLD_EDITOR.md §3): the edit models (heights, paint, grass, objects, walk), the journal,
 * "revert this region", and the Save payload (the layer files as the shared codecs encode them, placements.json,
 * edits.json with the base hash per region, the journal). Environment-neutral apart from `crypto.subtle` (browsers
 * and Node both have it): the unit tests drive it without an engine.
 */
import {
  WORLD_EDITS_FORMAT, WORLD_EDITS_VERSION, WE_GRASS, WE_GRID, WE_TILES,
  decodeGrassLayer, decodeHeightLayer, decodePaintLayer, decodeWalkLayer, encodeGrassLayer, encodeHeightLayer, encodePaintLayer,
  encodeWalkLayer, regionOfPosition,
  type WorldEditLayerKind, type WorldEditPlacementsFile, type WorldEditsIndex,
} from '../../../../packages/shared/src/world-edits/index.ts'
import type { WorldPlacement } from '../../../../packages/convert/src/world/manifest.ts'
import { GrassEdits } from './grass-edits.ts'
import { History, decodeChange, encodeChange, type Change, type ChangeParts, type ChangeTarget } from './history.ts'
import { Lattice } from './lattice.ts'
import { ObjectEdits, isAddRef, type ObjectChangeItem } from './object-edits.ts'
import { PaintEdits, type WordsHost } from './paint-edits.ts'
import { HeightEdits, type HeightHost } from './terrain-edits.ts'
import { WalkEdits } from './walk-edits.ts'

/** One layer file as raw pixels (the codecs' output; row 0 = north). `pixels` null: delete the file. */
export interface LayerFile {
  kind: WorldEditLayerKind
  x: number
  z: number
  width: number
  height: number
  channels: 1 | 2 | 4
  depth: 8 | 16
  /** Base64 of the pixel bytes (16-bit samples little-endian). */
  pixels: string | null
}

export interface SavePayload {
  world: string
  files: { 'edits.json': WorldEditsIndex; 'placements.json': WorldEditPlacementsFile }
  layers: LayerFile[]
  journal: Array<Record<string, unknown>>
}

export interface LoadPayload {
  files?: { 'placements.json'?: WorldEditPlacementsFile; 'edits.json'?: WorldEditsIndex }
  layers?: LayerFile[]
  journal?: Array<Record<string, unknown>>
}

export interface SessionOptions {
  world: string
  originRegion: { x: number; z: number }
  /** Region ids in the export. */
  regions: Iterable<number>
  placements: readonly WorldPlacement[]
  host: HeightHost & WordsHost
}

export type SessionListener = (parts: ChangeParts) => void

export class EditSession implements ChangeTarget {
  readonly lattice: Lattice
  readonly heights: HeightEdits
  readonly paint: PaintEdits
  readonly grass: GrassEdits
  readonly objects: ObjectEdits
  readonly walk: WalkEdits
  readonly history: History
  readonly world: string
  private readonly exported: Set<number>
  private readonly listeners: SessionListener[] = []
  /** Layer files written by the last Save or load (a region whose layer went away gets a delete). */
  private readonly saved = new Set<string>()
  /**
   * edits.json `base` per region: the hash of the export's heights the region's edits were made on. Kept from the
   * loaded file, computed only for a region first edited in this session (never re-stamped from the export as it is
   * now, never ''), so the converter and Publish can still say "the ground under your edit changed" (H-12 DL-4).
   */
  private readonly bases = new Map<number, string>()
  /** Changes since the last Save. */
  unsaved = 0

  constructor(readonly opts: SessionOptions) {
    this.world = opts.world
    this.exported = new Set(opts.regions)
    const exists = (id: number) => this.exported.has(id)
    this.lattice = new Lattice(opts.originRegion.x, opts.originRegion.z, exists)
    this.heights = new HeightEdits(this.lattice, opts.host)
    this.paint = new PaintEdits(this.lattice, opts.host)
    this.grass = new GrassEdits(opts.originRegion.x, opts.originRegion.z, exists)
    this.objects = new ObjectEdits(opts.placements, opts.originRegion, opts.world)
    this.walk = new WalkEdits(opts.originRegion.x, opts.originRegion.z, exists)
    this.history = new History(this)
  }

  onChange(l: SessionListener): () => void {
    this.listeners.push(l)
    return () => {
      const i = this.listeners.indexOf(l)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  private notify(parts: ChangeParts): void {
    for (const l of this.listeners) l(parts)
  }

  // ---- ChangeTarget -------------------------------------------------------------------------------------------------

  apply(parts: ChangeParts, which: 'before' | 'after'): void {
    // heights by difference (exact: multiples of 1/256 m), so an earlier change reverted out of order stays out
    if (parts.height) this.heights.shift(parts.height, which === 'before' ? -1 : 1)
    if (parts.paint) this.paint.apply(parts.paint, which)
    if (parts.grass) this.grass.apply(parts.grass, which)
    if (parts.objects) this.objects.apply(parts.objects, which)
    if (parts.walk) this.walk.apply(parts.walk, which)
    this.unsaved++
    this.notify(parts)
  }

  toggle(parts: ChangeParts, sign: 1 | -1, later: readonly Change[]): void {
    if (parts.height) this.heights.shift(parts.height, sign)
    if (parts.paint) {
      const p = parts.paint
      rebase(p.keys, i => p.before[i]!, i => p.after[i]!, sign, later, c => c.paint && keyedPart(c.paint.keys, (j, v) => (c.paint!.before[j] = v)), (k, v) => this.paint.setKey(k as number, v))
    }
    if (parts.grass) {
      const g = parts.grass
      rebase(g.keys, i => g.before[i]!, i => g.after[i]!, sign, later, c => c.grass && keyedPart(c.grass.keys, (j, v) => (c.grass!.before[j] = v)), (k, v) => this.grass.setKey(k as number, v))
    }
    if (parts.objects) {
      const items = parts.objects.items
      rebase(items.map(i => i.ref), i => items[i]!.before, i => items[i]!.after, sign, later,
        c => c.objects && keyedPart(c.objects.items.map(i => i.ref), (j, v) => (c.objects!.items[j]!.before = v)),
        (k, v) => this.objects.set(k as string, v))
    }
    if (parts.walk) {
      const w = parts.walk
      rebase(w.keys, i => w.before[i]!, i => w.after[i]!, sign, later, c => c.walk && keyedPart(c.walk.keys, (j, v) => (c.walk!.before[j] = v)), (k, v) => this.walk.setKey(k as number, v))
    }
    this.unsaved++
    this.notify(parts)
  }

  /** The camera to record with each change (position xyz, target xyz); the page sets it. */
  viewOf: (() => number[]) | null = null

  /** Records a change already applied (a stroke's end, a gizmo drop) and tells the listeners. */
  record(parts: ChangeParts, label: string, regions: number[]): Change {
    const c = this.history.push(parts, label, regions)
    const v = this.viewOf?.()
    if (v && v.length === 6 && v.every(Number.isFinite)) c.view = v.map(x => Math.round(x * 100) / 100)
    this.unsaved++
    this.notify(parts)
    return c
  }

  undo(): Change | null {
    return this.history.undo()
  }

  redo(): Change | null {
    return this.history.redo()
  }

  /** Revert / re-apply one change (the Changes panel's link). */
  revertOne(id: number): Change | null {
    return this.history.toggle(id)
  }

  // ---- regions ------------------------------------------------------------------------------------------------------

  /** The owner region of a glTF position. */
  regionAt(x: number, z: number): number {
    return regionOfPosition([x, 0, z], this.opts.originRegion)
  }

  /** Every region with an edit of any kind (heights, paint, grass, walk, objects at their old or new owner). */
  touchedRegions(): number[] {
    const s = new Set<number>([...this.heights.touchedRegions(), ...this.paint.touchedRegions(), ...this.grass.touchedRegions(), ...this.walk.touchedRegions()])
    for (const ref of this.objects.editedRefs()) {
      const p = this.objects.placementOf(ref)
      if (p) s.add(p.region)
      const cur = this.objects.current(ref)
      if (cur) s.add(this.regionAt(cur.position[0], cur.position[2]))
    }
    return [...s].sort((a, b) => a - b)
  }

  /**
   * "Revert this region" (§3.4): removes its height, paint, grass and walk layers and the edits of the objects it owns
   * (or that now stand in it); one change, itself undoable. Null when the region has no edit.
   */
  revertRegion(id: number): Change | null {
    const parts: ChangeParts = {}
    const h = this.heights.clearRegion(id)
    if (h) parts.height = h
    const p = this.paint.clearRegion(id)
    if (p) parts.paint = p
    const g = this.grass.clearRegion(id)
    if (g) parts.grass = g
    const w = this.walk.clearRegion(id)
    if (w) parts.walk = w
    const items: ObjectChangeItem[] = []
    for (const ref of this.objects.editedRefs()) {
      const orig = this.objects.placementOf(ref)
      const cur = this.objects.current(ref)
      const inRegion = (orig && orig.region === id) || (cur && this.regionAt(cur.position[0], cur.position[2]) === id)
      if (!inRegion) continue
      const after = isAddRef(ref) ? null : this.objects.original(ref)
      items.push({ ref, before: cur, after })
    }
    if (items.length) {
      parts.objects = { items }
      this.objects.apply(parts.objects, 'after')
    }
    if (!parts.height && !parts.paint && !parts.grass && !parts.objects && !parts.walk) return null
    const regions = new Set<number>([id, ...(h?.regions ?? []), ...(p?.regions ?? [])])
    return this.record(parts, `Reverted region ${id & 0xff},${id >> 8} to the original map`, [...regions].sort((a, b) => a - b))
  }

  /**
   * "The original map" without recording anything (Publish's before pictures, the Compare button): takes every
   * height, paint, grass and object edit out of the live state and returns what `restoreEdits` needs to put them back
   * exactly (by difference, as undo does). Empty when nothing is edited. The listeners hear each part.
   */
  hideEdits(): ChangeParts[] {
    const out: ChangeParts[] = []
    for (const id of [...this.heights.touchedRegions()]) {
      const h = this.heights.clearRegion(id)
      if (h) out.push({ height: h })
    }
    for (const id of [...this.paint.touchedRegions()]) {
      const p = this.paint.clearRegion(id)
      if (p) out.push({ paint: p })
    }
    for (const id of [...this.grass.touchedRegions()]) {
      const g = this.grass.clearRegion(id)
      if (g) out.push({ grass: g })
    }
    for (const id of [...this.walk.touchedRegions()]) {
      const w = this.walk.clearRegion(id)
      if (w) out.push({ walk: w })
    }
    const items: ObjectChangeItem[] = []
    for (const ref of this.objects.editedRefs()) items.push({ ref, before: this.objects.current(ref), after: isAddRef(ref) ? null : this.objects.original(ref) })
    if (items.length) {
      const objects = { items }
      this.objects.apply(objects, 'after')
      out.push({ objects })
    }
    for (const p of out) this.notify(p)
    return out
  }

  /** Puts back what `hideEdits` took out (newest first); the unsaved count is unchanged. */
  restoreEdits(hidden: readonly ChangeParts[]): void {
    const unsaved = this.unsaved
    for (let i = hidden.length - 1; i >= 0; i--) this.apply(hidden[i]!, 'before')
    this.unsaved = unsaved
  }

  // ---- Save / load --------------------------------------------------------------------------------------------------

  /** The Save payload: every touched layer, a delete for a layer that went away, placements.json, edits.json. */
  async buildSave(): Promise<SavePayload> {
    const layers: LayerFile[] = []
    const kinds = new Map<number, Set<WorldEditLayerKind>>()
    const add = (id: number, kind: WorldEditLayerKind) => {
      let s = kinds.get(id)
      if (!s) kinds.set(id, (s = new Set()))
      s.add(kind)
    }
    const now = new Set<string>()
    for (const id of this.heights.touchedRegions()) {
      const l = this.heights.layer(id)
      if (!l) continue
      add(id, 'height')
      now.add(`height:${id}`)
      layers.push(layerFile('height', id, WE_GRID, 2, 16, encodeHeightLayer(l)))
    }
    for (const id of this.paint.touchedRegions()) {
      const l = this.paint.layer(id)
      if (!l) continue
      add(id, 'paint')
      now.add(`paint:${id}`)
      layers.push(layerFile('paint', id, WE_GRID, 4, 8, encodePaintLayer(l)))
    }
    for (const id of this.grass.touchedRegions()) {
      const l = this.grass.layer(id)
      if (!l) continue
      add(id, 'grass')
      now.add(`grass:${id}`)
      layers.push(layerFile('grass', id, WE_GRASS, 4, 8, encodeGrassLayer(l)))
    }
    for (const id of this.walk.touchedRegions()) {
      const l = this.walk.layer(id)
      if (!l) continue
      add(id, 'walk')
      now.add(`walk:${id}`)
      layers.push(layerFile('walk', id, WE_TILES, 1, 8, encodeWalkLayer(l)))
    }
    for (const key of this.saved) {
      if (now.has(key)) continue
      const [kind, idText] = key.split(':') as [WorldEditLayerKind, string]
      const id = Number(idText)
      layers.push({ kind, x: id & 0xff, z: id >> 8, width: 0, height: 0, channels: 1, depth: 8, pixels: null })
    }
    const regions: WorldEditsIndex['regions'] = []
    for (const id of [...kinds.keys()].sort((a, b) => a - b)) {
      let base = this.bases.get(id)
      if (!base) {
        const heights = this.heights.baseOf(id)
        if (heights) this.bases.set(id, (base = await sha256Hex(heights)))
      }
      regions.push({ x: id & 0xff, z: id >> 8, base: base ?? '', layers: [...kinds.get(id)!].sort() })
    }
    const placements = this.objects.toFile()
    const index: WorldEditsIndex = {
      format: WORLD_EDITS_FORMAT, version: WORLD_EDITS_VERSION, world: this.world, regions,
      counts: {
        height: this.heights.touchedRegions().length, paint: this.paint.touchedRegions().length, grass: this.grass.touchedRegions().length,
        walk: this.walk.touchedRegions().length, move: placements.move.length, drop: placements.drop.length, add: placements.add.length,
      },
    }
    return {
      world: this.world,
      files: { 'edits.json': index, 'placements.json': placements },
      layers,
      journal: this.history.changes.map(encodeChange),
    }
  }

  /**
   * The resident regions whose export ground is no longer the one their saved edits were made on (a coast re-run, a
   * re-export): WORLD_EDITOR §3.1's "the ground under your edit changed".
   */
  async changedBases(): Promise<number[]> {
    const out: number[] = []
    for (const [id, want] of this.bases) {
      const heights = this.heights.baseOf(id)
      if (heights && (await sha256Hex(heights)) !== want) out.push(id)
    }
    return out.sort((a, b) => a - b)
  }

  /** After a successful Save: what is on disk now. */
  markSaved(payload: SavePayload): void {
    this.saved.clear()
    for (const l of payload.layers) if (l.pixels) this.saved.add(`${l.kind}:${(l.z << 8) | l.x}`)
    this.unsaved = 0
  }

  /** Loads saved edits (the editor's start, before regions stream in or while they are resident). */
  load(payload: LoadPayload): string[] {
    const problems: string[] = []
    for (const l of payload.layers ?? []) {
      if (!l.pixels) continue
      const id = (l.z << 8) | l.x
      try {
        if (l.kind === 'height') this.heights.loadLayer(id, decodeHeightLayer(unpackPixels(l)))
        else if (l.kind === 'paint') this.paint.loadLayer(id, decodePaintLayer(unpackPixels(l)))
        else if (l.kind === 'grass') this.grass.loadLayer(id, decodeGrassLayer(unpackPixels(l)))
        else if (l.kind === 'walk') this.walk.loadLayer(id, decodeWalkLayer(unpackPixels(l)))
        else continue
        this.saved.add(`${l.kind}:${id}`)
      } catch (err) {
        problems.push(`${l.kind} layer ${l.x},${l.z}: ${(err as Error).message}`)
      }
    }
    for (const r of payload.files?.['edits.json']?.regions ?? []) {
      if (typeof r.base === 'string' && /^[0-9a-f]{64}$/.test(r.base)) this.bases.set((r.z << 8) | r.x, r.base)
    }
    const pf = payload.files?.['placements.json']
    if (pf) problems.push(...this.objects.loadFile(pf))
    if (payload.journal?.length) {
      try {
        this.history.restore(payload.journal.map(decodeChange))
      } catch (err) {
        problems.push(`journal: ${(err as Error).message}`)
      }
    }
    this.unsaved = 0
    this.notify({})
    return problems
  }
}

// ---- the journal's rebase ------------------------------------------------------------------------------------------------

interface KeyedPart<V> {
  index: Map<number | string, number>
  setBefore(j: number, v: V): void
}

function keyedPart<V>(keys: ArrayLike<number | string>, setBefore: (j: number, v: V) => void): KeyedPart<V> {
  const index = new Map<number | string, number>()
  for (let j = 0; j < keys.length; j++) index.set(keys[j]!, j)
  return { index, setBefore }
}

/**
 * Takes one change out of the chain of values each key went through (-1), or puts it back (+1): the nearest later
 * writer of the key gets the new `before`; the live value changes only where no later change in effect wrote it.
 * Assignment-based parts (paint, grass, objects) stay exact under any order of undo, redo and revert.
 */
function rebase<V>(
  keys: ArrayLike<number | string>, before: (i: number) => V, after: (i: number) => V, sign: 1 | -1, later: readonly Change[],
  partOf: (c: Change) => KeyedPart<V> | undefined, setCurrent: (key: number | string, v: V) => void,
): void {
  const parts = later.map(c => ({ c, part: partOf(c) }))
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!
    const v = sign < 0 ? before(i) : after(i)
    let patched = false
    let live = true
    for (const { c, part } of parts) {
      const j = part?.index.get(key)
      if (j === undefined) continue
      if (!patched) {
        part!.setBefore(j, v)
        patched = true
      }
      if (c.state === 'done') {
        live = false
        break
      }
    }
    if (live) setCurrent(key, v)
  }
}

// ---- pixels ------------------------------------------------------------------------------------------------------------

function layerFile(kind: WorldEditLayerKind, id: number, size: number, channels: 1 | 2 | 4, depth: 8 | 16, px: Uint8Array | Uint16Array): LayerFile {
  return { kind, x: id & 0xff, z: id >> 8, width: size, height: size, channels, depth, pixels: bytesB64(new Uint8Array(px.buffer, px.byteOffset, px.byteLength)) }
}

export function bytesB64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}

export function b64Bytes(s: string): Uint8Array {
  const bin = atob(s)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

/** A layer file's samples: Uint16Array for 16-bit, Uint8Array for 8-bit. */
export function unpackPixels(l: LayerFile): Uint8Array | Uint16Array {
  const u8 = b64Bytes(l.pixels ?? '')
  return l.depth === 16 ? new Uint16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1) : u8
}

/** SHA-256 (hex) of a region's exported heights, as little-endian float32 bytes (edits.json `base`). */
export async function sha256Hex(heights: Float32Array): Promise<string> {
  const bytes = new Uint8Array(heights.byteLength)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < heights.length; i++) view.setFloat32(i * 4, heights[i]!, true)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
