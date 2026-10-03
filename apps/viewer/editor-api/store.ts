/**
 * The editor's files (docs/WORLD_EDITOR.md §3.1, §3.4, §3.5): the world's layer folder
 * `content/world-edits/<world>/` and its work folder `work/editor/<world>/` (journal, patches). Reads decode the
 * layer PNGs to pixels; a save validates and encodes everything first, then writes in one two-phase commit
 * (./atomic.ts): patches, then layers, then the journal last, then the stale patches go.
 *
 * Save never refuses a layer for what the shared validators say (it must never lose work, D18): their problems come
 * back as warnings and Publish refuses them. It refuses only what cannot be a layer: an unknown path, pixels of the
 * wrong size, a JSON layer that does not parse, a journal that does not fit.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  decodeGrassLayer, decodeHeightLayer, decodePaintLayer, decodeWalkLayer,
} from '../../../packages/shared/src/world-edits/codecs.ts'
import {
  validateGrassLayer, validateHeightLayer, validatePaintLayer, validateWalkLayer, validateWorldEditLights,
  validateWorldEditPlacements, validateWorldEditProbes, validateWorldEditsIndex, validateWorldEditWater,
  validateWorldEditZones, type WorldEditsContext,
} from '../../../packages/shared/src/world-edits/validate.ts'
import { commitFiles, resolveUnder, type FileStep, type WriteScope } from './atomic.ts'
import {
  JOURNAL_FILE, JournalError, journalState, planJournalRecords, planJournalReset, planJournalUpdate, readJournal,
  serializeJournal, type JournalData,
} from './journal.ts'
import { decodePng, encodePng } from './png.ts'
import {
  JSON_LAYER_FILES, LAYER_FORMATS, base64ToBytes, bytesToBase64, bytesToPixels, isJsonLayerFile, layerPixelsEmpty,
  parseLayerPath, pixelsToBytes, type EditorLoad, type JournalState, type JournalUpdate, type LayerFileInfo,
  type LayerKind, type PageChangeRecord, type PageLayerFile, type PageSaveRequest, type SaveFile, type SaveRequest,
  type SaveResult,
} from './protocol.ts'

export class SaveError extends Error {}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

export interface EditorStoreOptions {
  world: string
  /** content/world-edits/<world> (absolute). */
  layerDir: string
  /** work/editor/<world> (absolute). */
  workDir: string
  scope: WriteScope
  /** The export's context for the validators (the world, its regions, ...); none = shape checks only. */
  context?: () => WorldEditsContext
  journalCap?: { maxChanges?: number; maxBytes?: number }
}

/** Layer pixels of a kind from a PNG file's bytes (the channel layout must match). */
export function layerPixelsFromPng(kind: LayerKind, png: Uint8Array): Uint8Array | Uint16Array {
  const f = LAYER_FORMATS[kind]
  const img = decodePng(png)
  if (img.width !== f.width || img.height !== f.height) throw new Error(`a ${kind} layer is ${f.width} x ${f.height}, this file is ${img.width} x ${img.height}`)
  if (img.channels !== f.channels || img.depth !== f.depth) {
    throw new Error(`a ${kind} layer has ${f.channels} channel(s) at ${f.depth} bits, this file ${img.channels} at ${img.depth}`)
  }
  return img.data
}

export const layerPng = (kind: LayerKind, px: Uint8Array | Uint16Array) => {
  const f = LAYER_FORMATS[kind]
  return encodePng({ width: f.width, height: f.height, channels: f.channels, depth: f.depth, data: px })
}

/** Stable JSON text of a layer file (two-space indent, LF, final newline: small git diffs). */
export const layerJsonText = (json: unknown) => JSON.stringify(json, null, 2) + '\n'

function validateLayerPixels(path: string, px: Uint8Array | Uint16Array, ctx: WorldEditsContext): string[] {
  const p = parseLayerPath(path)!
  const r = p.kind === 'height' ? validateHeightLayer(p.x, p.z, decodeHeightLayer(px), ctx)
    : p.kind === 'paint' ? validatePaintLayer(p.x, p.z, decodePaintLayer(px), ctx)
      : p.kind === 'grass' ? validateGrassLayer(p.x, p.z, decodeGrassLayer(px), ctx)
        : validateWalkLayer(p.x, p.z, decodeWalkLayer(px), ctx)
  return r.problems.map(s => `${path}: ${s}`)
}

function validateJsonLayer(name: string, json: unknown, ctx: WorldEditsContext): string[] {
  const r = name === 'edits.json' ? validateWorldEditsIndex(json, ctx)
    : name === 'placements.json' ? validateWorldEditPlacements(json, ctx)
      : name === 'water.json' ? validateWorldEditWater(json, ctx)
        : name === 'lights.json' ? validateWorldEditLights(json)
          : name === 'zones.json' ? validateWorldEditZones(json, ctx)
            : name === 'probes.json' ? validateWorldEditProbes(json, ctx)
              : { ok: true, problems: [] }
  return r.problems.map(s => `${name}: ${s}`)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Both save forms (./protocol.ts) as one: the files to write and the journal's update or records. */
export function normalizeSave(body: unknown, world: string): { files: SaveFile[]; journal?: JournalUpdate; records?: unknown[] } {
  if (!isObj(body)) throw new SaveError('expected a save request')
  const b = body as { world?: unknown; files?: unknown; layers?: unknown; journal?: unknown }
  if (b.world !== undefined && b.world !== world) throw new SaveError(`this editor edits ${world}, not ${String(b.world)}`)
  const files: SaveFile[] = []
  if (Array.isArray(b.files)) files.push(...(b.files as SaveFile[]))
  else if (isObj(b.files)) {
    for (const [path, json] of Object.entries(b.files)) files.push(json === null ? { path, remove: true } : { path, json })
  } else if (b.files !== undefined) throw new SaveError('files must be a list or an object')
  if (b.layers !== undefined) {
    if (!Array.isArray(b.layers)) throw new SaveError('layers must be a list')
    for (const l of b.layers as PageLayerFile[]) {
      if (!isObj(l) || !(l.kind in LAYER_FORMATS) || !Number.isInteger(l.x) || !Number.isInteger(l.z) || l.x < 0 || l.x > 255 || l.z < 0 || l.z > 255) {
        throw new SaveError('every layer needs a kind (height, paint, grass, walk) and region coordinates x, z (0..255)')
      }
      const path = `${l.kind}/${l.x}_${l.z}.png`
      if (l.pixels === null) {
        files.push({ path, remove: true })
        continue
      }
      const f = LAYER_FORMATS[l.kind]
      if (l.width !== f.width || l.height !== f.height || l.channels !== f.channels || l.depth !== f.depth) {
        throw new SaveError(`${path}: a ${l.kind} layer is ${f.width} x ${f.height}, ${f.channels} channel(s) at ${f.depth} bits`)
      }
      files.push({ path, pixels: l.pixels })
    }
  }
  if (Array.isArray(b.journal)) return { files, records: b.journal }
  if (b.journal !== undefined && !isObj(b.journal)) throw new SaveError('journal must be an update or a list of changes')
  return { files, journal: b.journal as JournalUpdate | undefined }
}

const tracked = (path: string) => parseLayerPath(path) !== null || (isJsonLayerFile(path) && path !== 'palette.json')

export class EditorStore {
  readonly opts: EditorStoreOptions

  constructor(opts: EditorStoreOptions) {
    this.opts = opts
  }

  /** Every file in the layer folder (relative, forward slashes), sorted. */
  listFiles(): string[] {
    const dir = this.opts.layerDir
    if (!existsSync(dir)) return []
    const out: string[] = []
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        if (name.startsWith('.')) continue // temps of an interrupted write
        const file = join(d, name)
        if (statSync(file).isDirectory()) walk(file)
        else out.push(relative(dir, file).split('\\').join('/'))
      }
    }
    walk(dir)
    return out
  }

  fileInfo(): LayerFileInfo[] {
    return this.listFiles().map(path => {
      const data = readFileSync(join(this.opts.layerDir, ...path.split('/')))
      return { path, bytes: data.length, sha256: sha256(data) }
    })
  }

  /** The hashes of every edit layer the journal tracks (pixel and JSON layers; not the palette, WE-U's own file). */
  private hashes(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const f of this.fileInfo()) if (tracked(f.path)) out[f.path] = f.sha256
    return out
  }

  /** A layer's pixels, or null when the file is absent. */
  readLayer(path: string): Uint8Array | Uint16Array | null {
    const p = parseLayerPath(path)
    if (!p) throw new SaveError(`${JSON.stringify(path)} is not a layer file (height|paint|grass|walk/<x>_<z>.png)`)
    const file = resolveUnder(this.opts.layerDir, path)
    if (!existsSync(file)) return null
    return layerPixelsFromPng(p.kind, readFileSync(file))
  }

  /** A JSON layer, or undefined when the file is absent. */
  readJson(name: string): unknown {
    if (!isJsonLayerFile(name)) throw new SaveError(`${JSON.stringify(name)} is not a JSON layer file`)
    const file = resolveUnder(this.opts.layerDir, name)
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8'))
  }

  journal(): JournalData {
    return readJournal(this.opts.workDir, this.opts.world)
  }

  journalState(): JournalState {
    return journalState(this.journal())
  }

  readPatch(id: number): Uint8Array | null {
    if (!Number.isInteger(id) || id < 1) throw new SaveError('expected a change id')
    if (!this.journal().entries.some(e => e.id === id)) return null
    const file = join(this.opts.workDir, 'patches', `${id}.bin`)
    return existsSync(file) ? readFileSync(file) : null
  }

  /** Whether the layer files are what the last save recorded; the differing files. */
  consistency(): { consistent: boolean; mismatched: string[] } {
    const recorded = this.journal().header.files
    const now = this.hashes()
    const mismatched = [...new Set([...Object.keys(recorded), ...Object.keys(now)])]
      .filter(f => recorded[f] !== now[f])
      .sort()
    return { consistent: mismatched.length === 0, mismatched }
  }

  /** Validates and writes a save in one two-phase commit. */
  save(body: SaveRequest | PageSaveRequest): SaveResult {
    const req = normalizeSave(body, this.opts.world)
    const ctx = this.opts.context?.() ?? { world: this.opts.world }
    const warnings: string[] = []
    const layerSteps: FileStep[] = []
    const seen = new Set<string>()
    const hashes = this.hashes()
    for (const f of req.files) {
      if (typeof f?.path !== 'string') throw new SaveError('every file needs a path')
      if (seen.has(f.path)) throw new SaveError(`${f.path} is listed twice`)
      seen.add(f.path)
      const file = resolveUnder(this.opts.layerDir, f.path)
      const layer = parseLayerPath(f.path)
      if (!layer && !isJsonLayerFile(f.path)) throw new SaveError(`${JSON.stringify(f.path)} is not a layer file`)
      if (f.remove === true) {
        layerSteps.push({ file, remove: true })
        delete hashes[f.path]
        continue
      }
      if (layer) {
        if (typeof f.pixels !== 'string') throw new SaveError(`${f.path}: expected pixels (base64)`)
        const px = bytesToPixels(layer.kind, base64ToBytes(f.pixels))
        if (!px) throw new SaveError(`${f.path}: the pixels have the wrong size for a ${layer.kind} layer`)
        if (layerPixelsEmpty(layer.kind, px)) {
          // Nothing left in this layer (everything reverted): no file, so an empty edit layer exports byte-identical.
          layerSteps.push({ file, remove: true })
          delete hashes[f.path]
          continue
        }
        warnings.push(...validateLayerPixels(f.path, px, ctx))
        const png = layerPng(layer.kind, px)
        layerSteps.push({ file, data: png })
        hashes[f.path] = sha256(png)
      } else {
        if (f.json === undefined) throw new SaveError(`${f.path}: expected json`)
        warnings.push(...validateJsonLayer(f.path, f.json, ctx))
        const text = layerJsonText(f.json)
        layerSteps.push({ file, data: text })
        if (tracked(f.path)) hashes[f.path] = sha256(text)
      }
    }
    const current = this.journal()
    let plan
    try {
      plan = req.records
        ? planJournalRecords(this.opts.workDir, current, req.records, hashes, this.opts.journalCap)
        : planJournalUpdate(this.opts.workDir, current, req.journal, hashes, this.opts.journalCap)
    } catch (e) {
      throw e instanceof JournalError ? new SaveError(e.message) : e
    }
    const journalFile = join(this.opts.workDir, JOURNAL_FILE)
    const r = commitFiles(this.opts.scope, [
      ...plan.patches,
      ...layerSteps,
      { file: journalFile, data: serializeJournal(plan.next) },
      ...plan.stale,
    ])
    const rel = (abs: string) => relative(this.opts.layerDir, abs).split('\\').join('/')
    const layerFiles = new Set(layerSteps.map(s => s.file))
    return {
      ok: true,
      written: r.written.filter(f => layerFiles.has(f)).map(rel),
      removed: r.removed.filter(f => layerFiles.has(f)).map(rel),
      warnings,
      journal: journalState(plan.next),
    }
  }

  /** What the page needs to resume: every layer (page form), the JSON layers and the page's change records. */
  load(): EditorLoad {
    const files: EditorLoad['files'] = {}
    for (const name of JSON_LAYER_FILES) {
      const json = this.readJson(name)
      if (json !== undefined) files[name] = json
    }
    const layers: PageLayerFile[] = []
    for (const path of this.listFiles()) {
      const p = parseLayerPath(path)
      if (!p) continue
      const px = this.readLayer(path)!
      const f = LAYER_FORMATS[p.kind]
      layers.push({ kind: p.kind, x: p.x, z: p.z, width: f.width, height: f.height, channels: f.channels, depth: f.depth, pixels: bytesToBase64(pixelsToBytes(px)) })
    }
    const j = this.journal()
    const journal: PageChangeRecord[] = []
    for (const e of j.entries) {
      if (!e.record) continue
      const file = join(this.opts.workDir, 'patches', `${e.id}.bin`)
      if (existsSync(file)) journal.push(JSON.parse(readFileSync(file, 'utf8')) as PageChangeRecord)
    }
    return { world: this.opts.world, files, layers, journal, state: journalState(j) }
  }

  /** Clears the history (every change folds into the saved state) and records the layers as they are now. */
  resetJournal(): JournalState {
    const plan = planJournalReset(this.opts.workDir, this.journal(), this.hashes())
    commitFiles(this.opts.scope, [{ file: join(this.opts.workDir, JOURNAL_FILE), data: serializeJournal(plan.next) }, ...plan.stale])
    return journalState(plan.next)
  }
}
