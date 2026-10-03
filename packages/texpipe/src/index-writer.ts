/**
 * TP-E index writer (docs/WAVE_PLAN3.md §7.1 TP-E, D35): `work/out/pbr/index.json`, the `sro-pbr` v1 build index the
 * runtime loader (world-render `pbr/maps.ts`) reads, served unchanged under `/out-opt/pbr/` (TEXPIPE §6.1).
 *
 * A run merges its sets into the existing index (a `--set test` run keeps the hero sets of an earlier run), drops
 * every set whose files are gone (with a warning), turns a `replaced` status without a `gen:` set into `retail`
 * (the index would not validate otherwise), validates with format.ts `validatePbrIndex`, and writes atomically.
 * Keys are sorted so the file diffs cleanly between runs.
 *
 * Node only. The index holds paths and numbers only; nothing under work/out/pbr/ is committed (D43).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  fileStem, keyOf, OVERRIDES_FORMAT, OVERRIDES_VERSION, PBR_INDEX_FORMAT, PBR_INDEX_VERSION, validateOverrides, validatePbrIndex,
  type PbrIndex, type PbrSet, type TexpipeOverrides,
} from './format.ts'
import { REPO_ROOT } from './inventory.ts'
import { writeAtomic } from './upscale/cache.ts'

export const INDEX_NAME = 'index.json'

/** The index at `<pbrDir>/index.json`, or null when absent or not an `sro-pbr` v1 file. */
export function readPbrIndex(pbrDir: string): PbrIndex | null {
  const file = join(pbrDir, INDEX_NAME)
  if (!existsSync(file)) return null
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as PbrIndex
    return j.format === PBR_INDEX_FORMAT && j.version === PBR_INDEX_VERSION && j.sets && typeof j.sets === 'object' ? j : null
  } catch {
    return null
  }
}

/** The short git revision of the repo (with `+` when packages/texpipe has local changes), or 'unknown'. */
export function gitRev(root = REPO_ROOT): string {
  try {
    const rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'packages/texpipe'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return rev ? `${rev}${dirty ? '+' : ''}` : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The upscaler provenance: the models TP-U used for these keys (its up/index.json), or 'lanczos3'. */
export function upscalerOf(texpipeDir: string, keys: readonly string[]): string {
  const file = join(texpipeDir, 'up', 'index.json')
  const models = new Set<string>()
  try {
    const up = JSON.parse(readFileSync(file, 'utf8')) as { sets?: Record<string, { model?: string; aiMix?: number }> }
    for (const k of keys) {
      const r = up.sets?.[k]
      if (r?.model) models.add(r.model === 'lanczos' || !r.aiMix ? 'lanczos3' : `${r.model} (ncnn-vulkan) + lanczos3 mix`)
    }
  } catch {
    // no TP-U index: TP-P fell back to Lanczos3
  }
  return models.size ? [...models].sort().join(', ') : 'lanczos3'
}

export function pipelineInfo(texpipeDir: string, keys: readonly string[], now = new Date()): PbrIndex['pipeline'] {
  return { rev: gitRev(), upscaler: upscalerOf(texpipeDir, keys), createdAt: now.toISOString() }
}

/** Every file an index names, relative to pbr/ (tiers and KTX2 files). */
export function indexFiles(index: PbrIndex): string[] {
  const out: string[] = []
  for (const s of Object.values(index.sets)) out.push(...setFiles(s))
  return out
}

export function setFiles(s: PbrSet): string[] {
  const out: string[] = []
  for (const f of [s.albedo, s.normal, s.ormh, s.emissive]) if (f) out.push(f)
  for (const t of Object.values(s.tiers)) for (const f of [t.albedo, t.nx, t.ny, t.ao, t.rough, t.metal, t.height]) if (f) out.push(f)
  return out
}

/** The files an index names that are missing under pbrDir. */
export function missingFiles(index: PbrIndex, pbrDir: string): string[] {
  return indexFiles(index).filter(f => !existsSync(join(pbrDir, f)))
}

/**
 * The previous index with `sets` put in (same key = replaced), `drop` keys removed, and the pipeline provenance
 * updated. Pure; keys come out sorted.
 */
export function mergeIndex(prev: PbrIndex | null, sets: readonly PbrSet[], pipeline: PbrIndex['pipeline'], drop: readonly string[] = []): PbrIndex {
  const all: Record<string, PbrSet> = { ...(prev?.sets ?? {}) }
  for (const k of drop) delete all[k]
  for (const s of sets) all[s.key] = s
  const sorted: Record<string, PbrSet> = {}
  for (const k of Object.keys(all).sort()) sorted[k] = all[k]!
  return { format: PBR_INDEX_FORMAT, version: PBR_INDEX_VERSION, pipeline, sets: sorted }
}

/**
 * Repairs what would make an index invalid or stale, in place: sets whose files are missing are dropped, and a
 * `replaced` status no `gen:` set backs becomes `retail`. Returns one warning per change.
 */
export function repairIndex(index: PbrIndex, pbrDir: string | null): string[] {
  const warnings: string[] = []
  if (pbrDir) {
    for (const [k, s] of Object.entries(index.sets)) {
      const missing = setFiles(s).filter(f => !existsSync(join(pbrDir, f)))
      if (missing.length) {
        delete index.sets[k]
        warnings.push(`${k}: dropped from the index (${missing.length} file(s) missing, e.g. ${missing[0]})`)
      }
    }
  }
  const replacedBy = new Set(Object.values(index.sets).flatMap(s => (s.replaces ? [s.replaces] : [])))
  for (const s of Object.values(index.sets)) {
    if (s.status === 'replaced' && !replacedBy.has(s.key)) {
      s.status = 'retail'
      warnings.push(`${s.key}: status 'replaced' but no gen: set replaces it, written as 'retail'`)
    }
  }
  return warnings
}

/**
 * The sets an `sro-remaster` entry hides at runtime (D35: a `remaster/manifest.json` entry for a glb image wins over
 * the `sro-pbr` set of its retail path, silently). An entry `<glb>#<image>` names the retail textures of that glb's
 * sidecar whose file stem is the image name; a bare image name (or a glb without a sidecar) matches every set with
 * that stem. One line per hidden set, for the encode log; nothing when `<outDir>/remaster/manifest.json` is absent.
 */
export function remasterShadows(index: PbrIndex, outDir: string): string[] {
  let entries: Record<string, unknown>
  try {
    const m = JSON.parse(readFileSync(join(outDir, 'remaster', 'manifest.json'), 'utf8')) as { format?: string; textures?: Record<string, unknown> }
    if (m.format !== 'sro-remaster' || !m.textures || typeof m.textures !== 'object') return []
    entries = m.textures
  } catch {
    return []
  }
  const byStem = new Map<string, string[]>()
  for (const k of Object.keys(index.sets)) {
    const stem = fileStem(k)
    byStem.set(stem, [...(byStem.get(stem) ?? []), k])
  }
  const out: string[] = []
  for (const rk of Object.keys(entries).sort()) {
    const hash = rk.lastIndexOf('#')
    const image = (hash >= 0 ? rk.slice(hash + 1) : rk).toLowerCase()
    let keys = byStem.get(image) ?? []
    if (hash >= 0) {
      try {
        const side = JSON.parse(readFileSync(join(outDir, `${rk.slice(0, hash)}.json`), 'utf8')) as { materials?: Array<{ texture?: unknown }> }
        const own = new Set((side.materials ?? []).flatMap(m => (typeof m.texture === 'string' ? [keyOf(m.texture)] : [])))
        keys = keys.filter(k => own.has(k))
      } catch {
        // no sidecar: keep the stem match
      }
    }
    for (const k of keys) out.push(`${k}: hidden at runtime by the sro-remaster entry ${rk} (D35 precedence)`)
  }
  return out
}

/**
 * Writes each tile set's `cover` (TERRAIN_TEX §5.2 item 4: its share of the export's non-synthetic terrain vertices,
 * the inventory's `cover.all`, rounded to 6 decimals) from the inventory's tile entries, in place. Sets of tiles the
 * inventory does not list (a tile the export no longer uses) keep what they have. Returns how many sets changed.
 */
export function applyCover(index: PbrIndex, tiles: ReadonlyArray<{ key: string; cover?: { all: number } }>): number {
  let changed = 0
  for (const t of tiles) {
    const s = index.sets[t.key]
    if (!s || !t.key.startsWith('tile2d:') || !t.cover) continue
    const cover = Math.round(Math.min(1, Math.max(0, t.cover.all)) * 1e6) / 1e6
    if (s.cover !== cover) {
      s.cover = cover
      changed++
    }
  }
  return changed
}

/**
 * `texpipe hero <tile> on|off` (WAVE_PLAN8 D7, TERRAIN_TEX §5.3): flips a tile's `hero` in the overrides and, when
 * its set is encoded, in the index, without a re-encode (every B3 set is encoded with all its maps, so hero only
 * decides whether Medium and High sample them). Pure: returns copies and what changed; both results validate.
 * WE-A's Publish calls the verb for a tile painted past 0.1 % cover; nothing else edits the two files for it.
 */
export function flipHero(overrides: TexpipeOverrides, index: PbrIndex | null, key: string, on: boolean): {
  overrides: TexpipeOverrides
  index: PbrIndex | null
  changed: { overrides: boolean; index: boolean }
  warnings: string[]
} {
  if (!key.startsWith('tile2d:')) throw new Error(`hero: ${key} is not a terrain tile key (tile2d:<stem>)`)
  const warnings: string[] = []
  const o = structuredClone(overrides)
  const row = { ...(o.sets[key] ?? {}) }
  const changedO = row.hero !== on
  row.hero = on
  o.sets[key] = row
  const errs = validateOverrides(o)
  if (errs.length) throw new Error(`hero: overrides would not validate: ${errs.join('; ')}`)
  let idx: PbrIndex | null = index
  let changedI = false
  const set = index?.sets[key]
  if (!set) warnings.push(`${key}: not encoded yet; the index takes hero ${on ? 'on' : 'off'} at its first encode`)
  else {
    if (on && !Object.values(set.tiers).some(t => t.ao || t.nx)) warnings.push(`${key}: its set has no maps (status ${set.status}): hero gives it nothing until a re-encode`)
    if (set.hero !== on) {
      idx = structuredClone(index!)
      idx.sets[key]!.hero = on
      changedI = true
      const ierrs = validatePbrIndex(idx)
      if (ierrs.length) throw new Error(`hero: index would not validate: ${ierrs.join('; ')}`)
    }
  }
  return { overrides: o, index: idx, changed: { overrides: changedO, index: changedI }, warnings }
}

/**
 * Merges a lane's override fragment (WAVE_PLAN8 D7: T12-B's `content/trees/texpipe-rows.json`, an `sro-texpipe-
 * overrides` file or a bare `{ sets }`) into the overrides, key-disjoint: a fragment key that already has a different
 * row is refused unless `replace` (a re-merge of the same fragment at X2). Terrain keys (`tile2d:`) are TT-B's and
 * never come from a fragment. Pure; the result validates.
 */
export function mergeRows(overrides: TexpipeOverrides, fragment: unknown, opts: { replace?: boolean } = {}): {
  overrides: TexpipeOverrides
  added: string[]
  replaced: string[]
  same: string[]
} {
  const sets = (fragment && typeof fragment === 'object' && 'sets' in fragment ? (fragment as { sets: unknown }).sets : null) as Record<string, unknown> | null
  if (!sets || typeof sets !== 'object' || Array.isArray(sets)) throw new Error('merge-rows: the fragment has no sets object')
  const probe = validateOverrides({ format: OVERRIDES_FORMAT, version: OVERRIDES_VERSION, sets })
  if (probe.length) throw new Error(`merge-rows: the fragment does not validate: ${probe.join('; ')}`)
  const o = structuredClone(overrides)
  const added: string[] = [], replaced: string[] = [], same: string[] = [], clash: string[] = []
  for (const [key, row] of Object.entries(sets)) {
    if (key.startsWith('tile2d:')) throw new Error(`merge-rows: ${key} is a terrain key (TT-B's own rows)`)
    const cur = o.sets[key]
    if (!cur) added.push(key)
    else if (JSON.stringify(cur) === JSON.stringify(row)) same.push(key)
    else if (opts.replace) replaced.push(key)
    else clash.push(key)
    if (!cur || opts.replace) o.sets[key] = structuredClone(row) as TexpipeOverrides['sets'][string]
  }
  if (clash.length) throw new Error(`merge-rows: ${clash.length} key(s) already have another row (pass --replace to take the fragment's): ${clash.slice(0, 5).join(', ')}`)
  const errs = validateOverrides(o)
  if (errs.length) throw new Error(`merge-rows: the result would not validate: ${errs.join('; ')}`)
  return { overrides: o, added, replaced, same }
}

/** Validates and writes `<pbrDir>/index.json` atomically; throws with every problem when invalid. */
export function writePbrIndex(pbrDir: string, index: PbrIndex): string {
  const errors = validatePbrIndex(index)
  if (errors.length) throw new Error(`pbr index is invalid:\n  ${errors.join('\n  ')}`)
  const file = join(pbrDir, INDEX_NAME)
  writeAtomic(file, JSON.stringify(index, null, 1))
  return file
}

export interface IndexTotals {
  sets: number
  byStatus: Record<string, number>
  hero: number
  /** Bytes per tier name over every set that has it. */
  bytesByTier: Record<string, number>
  ktx2Bytes: number
}

/** Counts for the CLI summary and the review page header. */
export function indexTotals(index: PbrIndex, pbrDir?: string): IndexTotals {
  const t: IndexTotals = { sets: 0, byStatus: {}, hero: 0, bytesByTier: {}, ktx2Bytes: 0 }
  for (const s of Object.values(index.sets)) {
    t.sets++
    t.byStatus[s.status] = (t.byStatus[s.status] ?? 0) + 1
    if (s.hero) t.hero++
    for (const [n, tier] of Object.entries(s.tiers)) t.bytesByTier[n] = (t.bytesByTier[n] ?? 0) + tier.bytes
    if (pbrDir) {
      for (const f of [s.albedo, s.normal, s.ormh, s.emissive]) {
        if (!f) continue
        try {
          t.ktx2Bytes += statSync(join(pbrDir, f)).size
        } catch {
          // counted as missing by repairIndex
        }
      }
    }
  }
  return t
}
