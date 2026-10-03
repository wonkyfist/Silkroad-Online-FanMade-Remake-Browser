/**
 * A change's patch (docs/WORLD_EDITOR.md §3.4, D16): the exact difference one user action made, stored as
 * `work/editor/<world>/patches/<id>.bin` beside the journal. Environment-neutral: the editor page builds and applies
 * patches (undo = apply backwards, redo = apply forwards), the API stores them, the tests replay them.
 *
 * Three kinds of op:
 * - `px`: layer pixels (the PNG's values, ./protocol.ts LAYER_FORMATS), the touched value indices with their values
 *   before and after. A layer that is absent reads as its empty pixels; a layer that becomes empty is absent again.
 * - `row`: one row of a JSON layer list, by key (placements: move / drop by `region:uid`, add by `id`; water, lights,
 *   zones, probes by `id`), with its index so an undone delete returns to the same place (byte-identical files).
 * - `file`: a whole JSON layer file (edits.json, palette.json, or a file's creation / removal); null = absent.
 *
 * Bytes: 'SREP', u32 version, u32 JSON length, the JSON (ops with blob offsets), zero padding to 4, the blobs
 * (per px op: u32 indices, then before, then after; little-endian).
 */
import { encodeGrassLayer, encodeHeightLayer, encodePaintLayer, encodeWalkLayer, emptyGrassLayer, emptyHeightLayer, emptyPaintLayer, emptyWalkLayer } from '../../../packages/shared/src/world-edits/codecs.ts'
import { LAYER_FORMATS, layerPixelsEmpty, layerValueCount, parseLayerPath, type JsonLayerFile, type LayerKind } from './protocol.ts'

export type Pixels = Uint8Array | Uint16Array
export type PlacementList = 'move' | 'drop' | 'add'

export type PatchOp =
  | { op: 'px'; path: string; idx: Uint32Array; before: Pixels; after: Pixels }
  | { op: 'row'; file: JsonLayerFile; list?: PlacementList; key: string; at: number; before: unknown; after: unknown }
  | { op: 'file'; file: JsonLayerFile; before: unknown; after: unknown }

export interface ChangePatch {
  ops: PatchOp[]
}

/** The editor's working copy of the layers, as the patches see it (absent = empty layer / no file). */
export interface LayerState {
  pixels: Map<string, Pixels>
  json: Map<string, unknown>
}

export const emptyLayerState = (): LayerState => ({ pixels: new Map(), json: new Map() })

/** A layer kind's empty pixels (what an absent file reads as). */
export function emptyLayerPixels(kind: LayerKind): Pixels {
  switch (kind) {
    case 'height': return encodeHeightLayer(emptyHeightLayer())
    case 'paint': return encodePaintLayer(emptyPaintLayer())
    case 'grass': return encodeGrassLayer(emptyGrassLayer())
    case 'walk': return encodeWalkLayer(emptyWalkLayer())
  }
}

function layerKindOf(path: string): LayerKind {
  const p = parseLayerPath(path)
  if (!p) throw new Error(`patch: ${JSON.stringify(path)} is not a layer path`)
  return p.kind
}

/** The px op between two pixel arrays of one layer (null when equal). */
export function diffPixels(path: string, before: Pixels, after: Pixels): PatchOp | null {
  const kind = layerKindOf(path)
  const n = layerValueCount(kind)
  if (before.length !== n || after.length !== n) throw new Error(`patch: ${path} needs ${n} values`)
  const idx: number[] = []
  for (let i = 0; i < n; i++) if (before[i] !== after[i]) idx.push(i)
  if (!idx.length) return null
  const Arr = LAYER_FORMATS[kind].depth === 16 ? Uint16Array : Uint8Array
  const b = new Arr(idx.length)
  const a = new Arr(idx.length)
  idx.forEach((i, k) => {
    b[k] = before[i]!
    a[k] = after[i]!
  })
  return { op: 'px', path, idx: Uint32Array.from(idx), before: b, after: a }
}

/** The key a JSON layer row is addressed by. */
export function rowKey(file: JsonLayerFile, list: PlacementList | undefined, row: unknown): string {
  const r = row as Record<string, unknown>
  if (file === 'placements.json' && list !== 'add') return `${r.region}:${r.uid}`
  return String(r.id)
}

function rowsOf(state: LayerState, file: JsonLayerFile, list: PlacementList | undefined): unknown[] {
  const json = state.json.get(file)
  if (json === undefined) throw new Error(`patch: ${file} is absent; a row op needs the file`)
  if (file === 'placements.json') {
    if (!list) throw new Error('patch: a placements row op needs its list (move, drop, add)')
    const obj = json as Record<string, unknown>
    if (!Array.isArray(obj[list])) obj[list] = []
    return obj[list] as unknown[]
  }
  if (!Array.isArray(json)) throw new Error(`patch: ${file} is not a list`)
  return json
}

const clone = <T>(v: T): T => (v === undefined || v === null ? v : (JSON.parse(JSON.stringify(v)) as T))

function applyOp(state: LayerState, op: PatchOp, forward: boolean): void {
  if (op.op === 'px') {
    const kind = layerKindOf(op.path)
    const from = forward ? op.before : op.after
    const to = forward ? op.after : op.before
    const px = state.pixels.get(op.path) ?? emptyLayerPixels(kind)
    for (let k = 0; k < op.idx.length; k++) {
      const i = op.idx[k]!
      if (px[i] !== from[k]) throw new Error(`patch: ${op.path} value ${i} is ${px[i]}, expected ${from[k]} (the history does not match the layers)`)
      px[i] = to[k]!
    }
    if (layerPixelsEmpty(kind, px)) state.pixels.delete(op.path)
    else state.pixels.set(op.path, px)
    return
  }
  const from = forward ? op.before : op.after
  const to = forward ? op.after : op.before
  if (op.op === 'file') {
    if (to === null || to === undefined) state.json.delete(op.file)
    else state.json.set(op.file, clone(to))
    return
  }
  const rows = rowsOf(state, op.file, op.list)
  const at = rows.findIndex(r => rowKey(op.file, op.list, r) === op.key)
  if (from !== null && from !== undefined) {
    if (at < 0) throw new Error(`patch: ${op.file} has no row ${op.key} (the history does not match the layers)`)
    if (to !== null && to !== undefined) rows[at] = clone(to)
    else rows.splice(at, 1)
    return
  }
  if (at >= 0) throw new Error(`patch: ${op.file} already has a row ${op.key}`)
  if (to !== null && to !== undefined) rows.splice(Math.max(0, Math.min(op.at, rows.length)), 0, clone(to))
}

/** Redo (forward) or undo (backward) a change on the working copy. Throws, untouched, when it does not fit the state. */
export function applyPatch(state: LayerState, patch: ChangePatch, forward = true): void {
  // Check on a copy of what the ops touch first, so a mismatch leaves the state as it was.
  const trial: LayerState = { pixels: new Map(), json: new Map() }
  for (const op of patch.ops) {
    if (op.op === 'px') {
      const px = state.pixels.get(op.path)
      if (px && !trial.pixels.has(op.path)) trial.pixels.set(op.path, px.slice())
    } else if (state.json.has(op.file) && !trial.json.has(op.file)) trial.json.set(op.file, clone(state.json.get(op.file)))
  }
  const ops = forward ? patch.ops : [...patch.ops].reverse()
  const touchedPx = new Set<string>()
  const touchedJson = new Set<string>()
  for (const op of ops) {
    applyOp(trial, op, forward)
    if (op.op === 'px') touchedPx.add(op.path)
    else touchedJson.add(op.file)
  }
  for (const p of touchedPx) {
    const px = trial.pixels.get(p)
    if (px) state.pixels.set(p, px)
    else state.pixels.delete(p)
  }
  for (const f of touchedJson) {
    if (trial.json.has(f)) state.json.set(f, trial.json.get(f))
    else state.json.delete(f)
  }
}

// --- bytes --------------------------------------------------------------------------------------------------------

const MAGIC = [0x53, 0x52, 0x45, 0x50] // 'SREP'
const PATCH_VERSION = 1

type OpJson =
  | { op: 'px'; path: string; n: number; off: number }
  | Exclude<PatchOp, { op: 'px' }>

export function encodePatch(patch: ChangePatch): Uint8Array {
  const ops: OpJson[] = []
  const px: Array<{ op: Extract<PatchOp, { op: 'px' }>; off: number; wide: boolean }> = []
  let blob = 0
  for (const op of patch.ops) {
    if (op.op !== 'px') {
      ops.push(op)
      continue
    }
    const wide = LAYER_FORMATS[layerKindOf(op.path)].depth === 16
    const n = op.idx.length
    if (op.before.length !== n || op.after.length !== n) throw new Error(`patch: ${op.path} before / after lengths differ from the indices`)
    ops.push({ op: 'px', path: op.path, n, off: blob })
    px.push({ op, off: blob, wide })
    blob += n * 4 + n * (wide ? 4 : 2)
  }
  const json = new TextEncoder().encode(JSON.stringify({ ops }))
  const head = 12 + json.length
  const pad = (4 - (head % 4)) % 4
  const out = new Uint8Array(head + pad + blob)
  const dv = new DataView(out.buffer)
  out.set(MAGIC, 0)
  dv.setUint32(4, PATCH_VERSION, true)
  dv.setUint32(8, json.length, true)
  out.set(json, 12)
  const base = head + pad
  for (const { op, off, wide } of px) {
    const n = op.idx.length
    let p = base + off
    for (let i = 0; i < n; i++, p += 4) dv.setUint32(p, op.idx[i]!, true)
    for (const arr of [op.before, op.after]) {
      for (let i = 0; i < n; i++) {
        if (wide) {
          dv.setUint16(p, arr[i]!, true)
          p += 2
        } else out[p++] = arr[i]!
      }
    }
  }
  return out
}

export function decodePatch(bytes: Uint8Array): ChangePatch {
  if (bytes.length < 12 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('patch: not a patch file')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(4, true) !== PATCH_VERSION) throw new Error(`patch: version ${dv.getUint32(4, true)} is not supported`)
  const len = dv.getUint32(8, true)
  if (12 + len > bytes.length) throw new Error('patch: truncated')
  const parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + len))) as { ops: OpJson[] }
  const base = 12 + len + ((4 - ((12 + len) % 4)) % 4)
  const ops: PatchOp[] = parsed.ops.map(o => {
    if (o.op !== 'px') return o
    const wide = LAYER_FORMATS[layerKindOf(o.path)].depth === 16
    const end = base + o.off + o.n * 4 + o.n * (wide ? 4 : 2)
    if (end > bytes.length) throw new Error('patch: truncated')
    let p = base + o.off
    const idx = new Uint32Array(o.n)
    for (let i = 0; i < o.n; i++, p += 4) idx[i] = dv.getUint32(p, true)
    const read = (): Pixels => {
      const arr = wide ? new Uint16Array(o.n) : new Uint8Array(o.n)
      for (let i = 0; i < o.n; i++) {
        if (wide) {
          arr[i] = dv.getUint16(p, true)
          p += 2
        } else arr[i] = bytes[p++]!
      }
      return arr
    }
    const before = read()
    const after = read()
    return { op: 'px', path: o.path, idx, before, after }
  })
  return { ops }
}
