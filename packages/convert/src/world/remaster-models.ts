/**
 * Remastered world models (docs/REMASTER.md "World models"; lane DRAGON-INT, work/tmp/dragon/INTEGRATE.md): a retail
 * `.bsr` listed in `content/remaster/models.json` keeps its ordinary conversion, and the staged replacement (a glb +
 * sidecar made outside the converter, in the retail model's own space: same pivot, same scale) is appended as a
 * `'static'` manifest model next to it, `models[i].remasterVariant` = its index:
 *
 * - the variant's files are `models/<stem>.remaster.glb` + `.remaster.json` (beside the retail pair, so `optimize-out`
 *   gives them the same meshopt + webp pass) and its `source` is the retail one plus `#remaster` (every by-source lookup
 *   that skips `#` sources, the ambient rows, the dressing, the tree swap, the scatter, never matches it);
 * - the PBR path (Medium and up) loads the variant in the retail model's place (world-render batch/remaster.ts through
 *   `RegionBatcher.modelFor`); Low / Classic never sets a batcher and draws the retail model, so the Low path is
 *   unchanged; every placement, the nav (built from the retail `.bms`), the ambient particles (read from the retail BSR
 *   by the retail index) and the uid joins stay the retail model's;
 * - the entry's extra lightmap folders (`lightmaps/remaster/...`) are copied under the export; every lightmap the staged
 *   glb names must be one of them or a retail lightmap this export writes.
 *
 * Runs in the model loop of ./convert-world.ts (after the object lightmaps are written, before the pre-pass cache), so
 * the incremental convert (../tools/convert-region.ts) sees the variants in its cached models and reuses their files.
 *
 * The staged files are checked here, so a bad copy fails loudly (the pitfalls of INTEGRATE.md §7a): the sidecar's
 * `source` names the listed file (no control characters), the model is static, every material is single-sided (a
 * two-sided material doubles the batch's triangles), every primitive whose material names a lightmap has
 * `TEXCOORD_1`, and the Khronos validator reports no error. A missing staged file or a failed check throws, naming the
 * source; a listed source the export does not convert is a warning (another export).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { LIGHTMAP_EXTRAS_KEY, type Sidecar } from '../gltf/convert.ts'
import type { Vec3 } from '../gltf/space.ts'
import { validateGlb } from '../gltf/validate.ts'
import { gltfIO } from '../optimize/io.ts'
import type { WorldModel } from './manifest.ts'
import { normKey } from './objects.ts'
import { isFoliageModel } from './static-variants.ts'

export const REMASTER_MODELS_FORMAT = 'sro-model-remaster'
export const REMASTER_MODELS_VERSION = 1
/** The jangan-fields export's table (WorldPreset.remasterModels). */
export const JANGAN_REMASTER_MODELS = 'content/remaster/models.json'
/** The suffix on a variant's `source` (see the header). */
export const REMASTER_SOURCE_SUFFIX = '#remaster'

/** One listed retail model: its staged replacement (paths relative to the repo root, or absolute). */
export interface RemasterModelEntry {
  glb: string
  sidecar: string
  /** Export folder (`lightmaps/.../`, ending in '/') -> staged folder whose files are copied there. */
  lightmaps?: Record<string, string>
  why?: string
}

export interface RemasterModelsFile {
  format: typeof REMASTER_MODELS_FORMAT
  version: typeof REMASTER_MODELS_VERSION
  /** Retail `.bsr` path (as object.ifo spells it; compared case- and slash-insensitively) -> its replacement. */
  models: Record<string, RemasterModelEntry>
}

/** report.remasterModels: one row per appended variant. */
export interface RemasterModelsReportRow {
  source: string
  glb: string
  bytes: number
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
/** An export folder for lightmaps: relative, under `lightmaps/`, ending in '/', no '..' or backslash. */
const LIGHTMAP_FOLDER = /^lightmaps\/(?:[a-z0-9_-]+\/)+$/i
const CONTROL = /[\u0000-\u001f]/

/** Parses and checks the table (throws with the reason). */
export function parseRemasterModels(text: string): RemasterModelsFile {
  const f = JSON.parse(text) as unknown
  if (!isObj(f) || f.format !== REMASTER_MODELS_FORMAT || f.version !== REMASTER_MODELS_VERSION) {
    throw new Error(`remaster models: expected ${REMASTER_MODELS_FORMAT} v${REMASTER_MODELS_VERSION}`)
  }
  if (!isObj(f.models)) throw new Error('remaster models: expected models {<retail .bsr>: {glb, sidecar, lightmaps?}}')
  const seen = new Set<string>()
  for (const [source, e] of Object.entries(f.models)) {
    const at = `remaster models: ${source}`
    if (!/\.bsr$/i.test(source)) throw new Error(`${at}: expected a retail .bsr path`)
    if (seen.has(normKey(source))) throw new Error(`${at}: listed twice`)
    seen.add(normKey(source))
    if (!isObj(e) || !isStr(e.glb) || !/\.glb$/i.test(e.glb) || !isStr(e.sidecar) || !/\.json$/i.test(e.sidecar)) {
      throw new Error(`${at}: expected {glb: <.glb>, sidecar: <.json>, lightmaps?, why?}`)
    }
    if (e.why !== undefined && typeof e.why !== 'string') throw new Error(`${at}: why must be a string`)
    if (e.lightmaps !== undefined) {
      if (!isObj(e.lightmaps)) throw new Error(`${at}: lightmaps must be {<export folder>: <staged folder>}`)
      for (const [to, from] of Object.entries(e.lightmaps)) {
        if (!LIGHTMAP_FOLDER.test(to)) throw new Error(`${at}: lightmap folder ${JSON.stringify(to)} must be lightmaps/<path>/`)
        if (!isStr(from)) throw new Error(`${at}: lightmap folder ${to} needs a staged folder`)
      }
    }
  }
  return f as unknown as RemasterModelsFile
}

/** 'models/a/b.glb' -> 'models/a/b.remaster.glb' (also for the sidecar's .json). */
export function remasterPath(rel: string): string {
  return rel.replace(/(\.[^./]*)$/, '.remaster$1')
}

/** Every file under `dir`, as '/'-separated paths relative to it (sorted). */
function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, `${prefix}${name}/`))
    else out.push(`${prefix}${name}`)
  }
  return out
}

/** Copies `from` to `to`, unlinking `to` first (a hard-linked staging file is replaced, never written through). */
function copyFresh(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  rmSync(to, { force: true })
  copyFileSync(from, to)
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n))

export interface StageRemasterOptions {
  /** The export folder (absolute). */
  outDir: string
  /** Base of the entry's relative paths (the converter passes REPO_ROOT). */
  root: string
  /** The object lightmap URIs this export writes (convertModel's map values). */
  lightmapUris: ReadonlySet<string>
  /** Run the Khronos validator (default true). */
  validate?: boolean
}

export interface StagedRemasterModel {
  model: Omit<WorldModel, 'index'>
  sidecarBytes: number
  lightmapBytes: number
}

/** Checks one staged replacement of `of` and copies it into the export (see the header); throws naming the source. */
export async function stageRemasterModel(of: WorldModel, entry: RemasterModelEntry, opts: StageRemasterOptions): Promise<StagedRemasterModel> {
  const at = `remaster model ${of.source}`
  if (of.kind === 'failed' || !of.glb || !of.sidecar) throw new Error(`${at}: the retail model did not convert`)
  if (of.kind !== 'static') throw new Error(`${at}: only a static retail model can be remastered (it is ${of.kind})`)
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(opts.root, p))
  const glbFile = abs(entry.glb)
  const sidecarFile = abs(entry.sidecar)
  for (const f of [glbFile, sidecarFile]) if (!existsSync(f)) throw new Error(`${at}: missing staged file ${f}`)

  // the sidecar: it names this model, it is static
  const sidecarText = readFileSync(sidecarFile, 'utf8')
  const sidecar = JSON.parse(sidecarText) as Sidecar
  if (typeof sidecar.source !== 'string' || CONTROL.test(sidecar.source) || normKey(sidecar.source) !== normKey(of.source)) {
    throw new Error(`${at}: the staged sidecar names ${JSON.stringify(sidecar.source)}`)
  }
  const stats = sidecar.stats as Sidecar['stats'] | undefined
  if (!stats || !isVec3(stats.boundsMin) || !isVec3(stats.boundsMax)) throw new Error(`${at}: the staged sidecar has no bounds`)
  if (stats.joints || sidecar.animations?.length) throw new Error(`${at}: the staged model is skinned or animated`)

  // the extra lightmaps, copied first: the URIs they provide
  const provided = new Set<string>()
  let lightmapBytes = 0
  for (const [to, from] of Object.entries(entry.lightmaps ?? {})) {
    const dir = abs(from)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${at}: missing staged lightmap folder ${dir}`)
    for (const rel of listFiles(dir)) {
      const src = join(dir, ...rel.split('/'))
      copyFresh(src, join(opts.outDir, ...`${to}${rel}`.split('/')))
      provided.add(`${to}${rel}`)
      lightmapBytes += statSync(src).size
    }
  }

  // the glb: single-sided, lightmap UVs where a lightmap is named, every named lightmap exported
  const glb = new Uint8Array(readFileSync(glbFile))
  const doc = await (await gltfIO()).readBinary(glb)
  const uris = new Set<string>()
  for (const m of sidecar.meshes ?? []) {
    const uri = m.lightmap?.uri
    if (typeof uri === 'string') uris.add(uri)
  }
  for (const material of doc.getRoot().listMaterials()) {
    if (material.getDoubleSided()) throw new Error(`${at}: material ${material.getName()} is double-sided`)
    const lm = material.getExtras()[LIGHTMAP_EXTRAS_KEY] as { uri?: unknown; path?: unknown } | undefined
    if (lm && typeof lm.uri === 'string') uris.add(lm.uri)
    if (lm && typeof lm.path === 'string' && CONTROL.test(lm.path)) throw new Error(`${at}: material ${material.getName()}: bad lightmap path`)
  }
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const lm = prim.getMaterial()?.getExtras()[LIGHTMAP_EXTRAS_KEY]
      if (lm && !prim.getAttribute('TEXCOORD_1')) throw new Error(`${at}: mesh ${mesh.getName()} names a lightmap but has no TEXCOORD_1`)
    }
  }
  for (const uri of [...uris].sort()) {
    if (CONTROL.test(uri)) throw new Error(`${at}: bad lightmap uri ${JSON.stringify(uri)}`)
    if (!opts.lightmapUris.has(uri) && !provided.has(uri)) throw new Error(`${at}: names lightmap ${uri}, which the export does not write`)
  }
  let validatorErrors: number | null = null
  if (opts.validate !== false) {
    const v = await validateGlb(glb, remasterPath(of.glb).split('/').pop())
    validatorErrors = v.errors
    if (v.errors) throw new Error(`${at}: ${v.errors} glTF validator error(s) in ${glbFile}`)
  }

  const glbRel = remasterPath(of.glb)
  const sidecarRel = remasterPath(of.sidecar)
  copyFresh(glbFile, join(opts.outDir, ...glbRel.split('/')))
  copyFresh(sidecarFile, join(opts.outDir, ...sidecarRel.split('/')))
  return {
    model: {
      source: of.source + REMASTER_SOURCE_SUFFIX,
      glb: glbRel,
      sidecar: sidecarRel,
      kind: 'static',
      animations: [],
      defaultClip: null,
      lightmappedMeshes: (sidecar.meshes ?? []).filter(m => m.lightmap).length,
      boundsMin: [...stats.boundsMin] as Vec3,
      boundsMax: [...stats.boundsMax] as Vec3,
      bytes: glb.byteLength,
      validatorErrors,
    },
    sidecarBytes: Buffer.byteLength(sidecarText),
    lightmapBytes,
  }
}

export interface ApplyRemasterResult {
  /** `models` with the variants appended and `remasterVariant` set (new objects where changed). */
  models: WorldModel[]
  report: RemasterModelsReportRow[]
  bytes: { models: number; sidecars: number; lightmaps: number }
  validatorErrors: number
}

/**
 * Stages every listed model the export converted (see the header). `models` is not mutated. Throws on a bad staged
 * model; a listed source the export does not have, a tree or plant (the tree swap's), or one listed twice under
 * different spellings is a warning.
 */
export async function applyRemasterModels(
  models: readonly WorldModel[], file: RemasterModelsFile, opts: StageRemasterOptions & { warnings: string[]; log?: (line: string) => void },
): Promise<ApplyRemasterResult> {
  const out = models.slice()
  const bySource = new Map<string, WorldModel>()
  for (const m of models) if (!m.source.includes('#')) bySource.set(normKey(m.source), m)
  const report: RemasterModelsReportRow[] = []
  const bytes = { models: 0, sidecars: 0, lightmaps: 0 }
  let validatorErrors = 0
  for (const [source, entry] of Object.entries(file.models)) {
    const target = bySource.get(normKey(source))
    if (!target) {
      opts.warnings.push(`remaster model ${source}: not in this export`)
      continue
    }
    if (isFoliageModel(target.source)) {
      opts.warnings.push(`remaster model ${source}: a tree or plant is the tree swap's (content/trees/swap.json)`)
      continue
    }
    const cur = out[target.index]!
    if (cur.remasterVariant !== undefined) {
      opts.warnings.push(`remaster model ${source}: duplicate`)
      continue
    }
    const staged = await stageRemasterModel(cur, entry, opts)
    const index = out.length
    out.push({ ...staged.model, index })
    out[target.index] = { ...cur, remasterVariant: index }
    report.push({ source: target.source, glb: staged.model.glb!, bytes: staged.model.bytes })
    bytes.models += staged.model.bytes
    bytes.sidecars += staged.sidecarBytes
    bytes.lightmaps += staged.lightmapBytes
    validatorErrors += staged.model.validatorErrors ?? 0
    opts.log?.(`remaster model: ${target.source} -> ${staged.model.glb} (${(staged.model.bytes / 2 ** 20).toFixed(2)} MB` +
      `${staged.lightmapBytes ? `, ${(staged.lightmapBytes / 1024).toFixed(0)} KB lightmaps` : ''})`)
  }
  return { models: out, report, bytes, validatorErrors }
}
