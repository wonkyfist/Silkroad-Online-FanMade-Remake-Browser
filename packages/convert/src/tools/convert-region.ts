#!/usr/bin/env node
/**
 * The incremental world convert (wave 12, lane WE-I; docs/WORLD_EDITOR.md §6.2 step 2, F9, F14, F15, F17, D53;
 * docs/WAVE_PLAN8.md §6.2 WE-I, G7). The World Editor's Publish re-converts only what its layers can change, into a
 * staging export, and gets the list of files whose bytes differ from the live export:
 *
 *   pnpm tsx packages/convert/src/tools/convert-region.ts --world jangan-fields --only 171,97 [172,97 168-169,96-97 ...]
 *     [--live <dir>] [--staging <dir>] [--prepass <file>] [--snapshot <file> | --no-snapshot] [--coast run]
 *     [--no-record] [--json <file>] [--lock-wait <minutes>]
 *
 * The rule (G7): every file it writes has the bytes a full `pnpm sro convert-region --preset <world>` with the same
 * layers would write; the manifest equals the full convert's except for what differs between any two full converts (the
 * creation time, the timings, the size totals that include the manifest itself) and the order of its warnings
 * (`comparableManifest`). The test is ../../test/convert-region.test.ts; checkpoint X2 repeats it on the whole export.
 *
 * What is re-done, and from what:
 * - the core regions: `only` (the editor's touched regions, now and since the last publish) + the regions the layers
 *   touch (WorldEditsRun.touched) + the regions earlier incremental runs touched since the last full convert (the
 *   record, beside the pre-pass cache), and the 1-ring of all of them, whose normals cross the border: terrain bins for
 *   all, lightmaps and minimaps for the core (retail or the coast's, then the edits' hooks), and their world-map cells;
 * - the navigation of every region (retail .nvm -> the coast's edit -> the edits' navEdit). nav.bin and nav-objects.bin
 *   are rebuilt whole, because the instance order depends on every region's object list; per region, only the navmesh
 *   bins and nav chunks whose bytes changed are written (the splice). A chunk that changed outside the work set while
 *   no edit touched its region is drift (the live export is older than the converter or the content): listed, not fixed;
 * - the placement passes on the pre-pass cache that the last full convert wrote (../world/edits-hook.ts; F17: never on
 *   the manifest's post-pass list, which would apply C9's and the dressing's edits twice), then ambient.json, the spawn,
 *   the places, the town files, new tile images, and the manifest;
 * - the coast: its run takes about 25 s, so its edit-independent outputs (C9's placement edits, the post-coast .nvm of
 *   the regions it re-navigates, manifest.coast, report.coast, its warnings, which regions it changed, emitted or
 *   redrew) are kept in a snapshot beside the pre-pass cache and replayed. The coast runs only when the core or its ring
 *   reaches a region it changed or emitted (or their ring: the normals read the coast's heights), or a minimap it redrew
 *   over C9's drops, or when the snapshot is missing or stale; a run rewrites the snapshot.
 *
 * The staging export (F14): created fresh, then every live file hard-linked into it, except coast/ and models/trees/
 * (passes rewrite them whole). This tool writes only by temp + rename (a rename replaces the link, never the live file);
 * the passes that write over existing files are wrapped to unlink first (the town dressing's models and decals, the
 * static variants, which are reused from the live export when it has them instead of re-baked); at the end every live
 * file is linked in that the run did not write, and the live files behind the links are checked unchanged (size and
 * modification time), so a write through a link is an error rather than a silent edit of the live map. A hook or pass
 * that writes a file must write a new path or replace it by temp + rename.
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import sharp from 'sharp'
import {
  assembleRegionGrid, decodeDds, decodeMapTLightmap, isRegionActive, loadTextdataTable, parseBsr, parseDdj, parseMapM, parseMapT,
  parseMfo, parseNvm, parseTile2d, type MapMFile, type NvmFile, type RegionGrid,
} from '@sro/formats'
import { NavWorld, type NavData } from '@sro/nav'
import { zoneNameIndex } from '../data/zones.ts'
import { modelParticles, type ModelParticle } from '../fx/model-fx.ts'
import { toGltfPosition, UNIT_SCALE } from '../gltf/space.ts'
import { loadConfig, openArchive, REPO_ROOT, type SroConfig } from '../node-io.ts'
import { encodePng } from '../png.ts'
import { AMBIENT_FILE, buildAmbientIndex } from '../world/ambient.ts'
import { createCoastPass, S1_POINT, type CoastRun } from '../world/coast/hook.ts'
import { bakeRegionLightmap } from '../world/coast/lightmap.ts'
import { closeRing, reachesBothWays } from '../world/coast/links.ts'
import {
  coastMinimapOptions, coastMinimapTile, coastWorldMapFill, droppedTouches, type CoastMinimapTile,
} from '../world/coast/minimap.ts'
import { editRegionNav } from '../world/coast/navgen.ts'
import { convertLockPath, withConvertLock } from '../world/convert-lock.ts'
import {
  loadTownContent, parseRegionSpec, rectBounds, rectOf, regionOrigin, regionRange, TOWN_DRESSING_FILE, TOWN_FILE, WORLD_PRESETS,
  type RegionCoord, type WorldPreset,
} from '../world/convert-world.ts'
import { createWorldEdits } from '../world/edits/index.ts'
import { SOUND_ZONES_FILE } from '../world/edits/layers.ts'
import { parsePrePassCache, type EditsImage, type WorldEditsRun, type WorldEditsScene } from '../world/edits-hook.ts'
import { CELLS, encodeNavmeshBin, encodeTerrainBin, roundM } from '../world/format.ts'
import { grassPalettePass } from '../world/grass.ts'
import {
  WORLD_MANIFEST_FORMAT, WORLD_MANIFEST_VERSION, type TileTexture, type WorldCoast, type WorldManifest, type WorldModel,
  type WorldNav, type WorldPlace, type WorldPlacement, type WorldRegion, type WorldSpawn, type WorldStream,
} from '../world/manifest.ts'
import {
  buildWorldNav, NAV_FILE, NAV_OBJECTS_FILE, NAV_REGION_DIR, parseTeleportData, pickSpawnTeleport, spawnFromTeleport,
  splitWorldNav, TELEPORTDATA_PATH,
} from '../world/nav.ts'
import { outputStem, REGION_UNITS } from '../world/objects.ts'
import {
  editedFootprintProblems, runWorldPasses, type CoastPass, type PlacementEdits, type StaticVariantPass, type WorldPasses,
} from '../world/passes.ts'
import { buildPlaces } from '../world/places.ts'
import { STATIC_SOURCE_SUFFIX, staticPath, variantCandidates, writeStaticVariant } from '../world/static-variants.ts'
import { blockEntry, buildLayers, buildNormals, heightsToMetres } from '../world/terrain.ts'
import { createClothPass } from '../world/town/cloth.ts'
import { nodeDressingDeps } from '../world/town/dressing-io.ts'
import { createTownDressingPass, TOWN_DECALS_FILE, type DressingDeps } from '../world/town/dressing.ts'
import { createTreeSwapPass, speciesFolder } from '../world/trees-manifest.ts'
import { boxDownsample, WORLD_MAP_FILE, WORLD_MAP_FILL, type RgbaImage } from '../world/worldmap.ts'

// --- options and result ----------------------------------------------------------------------------------------------

export interface ConvertRegionsOptions {
  /** The export's name (manifest.name); a WORLD_PRESETS key unless `preset` is given. */
  world: string
  /** The preset (default WORLD_PRESETS[world]); the full convert this run must equal is convertWorld with it. */
  preset?: WorldPreset
  /** The regions to re-convert ({x, z} or z << 8 | x): the editor's touched regions, now and since the last publish. */
  only: ReadonlyArray<RegionCoord | number>
  /** The live export (default <workDir>/out/world/<world>). */
  liveDir?: string
  /** The staging export, replaced whole (default <liveDir>-edit). */
  stagingDir?: string
  /** The pre-pass cache of the last full convert (default <workDir>/cache/world/<world>/prepass.json). */
  prePassCache?: string
  /** The coast snapshot (default beside the pre-pass cache); null: never read or written (the coast always runs). */
  snapshot?: string | null
  /** 'auto' (default): replay the snapshot when the work set allows; 'run': always run the coast (and rewrite the snapshot). */
  coast?: 'auto' | 'run'
  /** The regions earlier runs touched (default beside the pre-pass cache); null: no record. */
  record?: string | null
  /** The layer folder (default preset.edits; relative to the repo root or absolute); null: none. */
  edits?: string | null
  /** The edits run itself, replacing the one `edits` would build (null: none). For tests and tools, as convertWorld's. */
  editsRun?: WorldEditsRun | null
  /** Replaces default passes, as convertWorld's `passes` (the full convert being matched must use the same). */
  passes?: WorldPasses
  cfg?: SroConfig
  log?: (line: string) => void
}

export interface ConvertRegionsResult {
  manifest: WorldManifest
  stagingDir: string
  /** Export-relative files the run wrote whose bytes differ from the live export's (new files included), sorted. */
  changed: string[]
  /** Live files the new export no longer has (the town files when their content is gone). */
  removed: string[]
  regions: {
    /** The core: `only` + the layers' touched regions + the record (ids z << 8 | x, ascending). */
    core: number[]
    /** The 1-ring of the core (terrain bins only). */
    ring: number[]
    /** Regions whose navigation the edits changed (navEdit). */
    nav: number[]
  }
  /** How the coast was handled. */
  coast: 'none' | 'snapshot' | 'run'
  /** Per-region outputs outside the work set that differ from the live export with no edit there (see the header). */
  drift: string[]
  timeMs: Record<string, number>
}

// --- small helpers ---------------------------------------------------------------------------------------------------

const idOf = (r: RegionCoord | number): number => (typeof r === 'number' ? r : (r.z << 8) | r.x)
const xzOf = (id: number): RegionCoord => ({ x: id & 0xff, z: id >> 8 })
const relOf = (root: string, file: string) => relative(root, file).split('\\').join('/')

/** Every file under `root` (relative, forward slashes, sorted). */
export function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push(relOf(root, p))
    }
  }
  if (existsSync(root)) walk(root)
  return out.sort()
}

/** The 8-neighbours of `ids` that are in `within` and not in `ids`. */
export function ringOf(ids: ReadonlySet<number>, within: ReadonlySet<number>): Set<number> {
  const out = new Set<number>()
  for (const id of ids) {
    const { x, z } = xzOf(id)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = ((z + dz) << 8) | (x + dx)
        if ((dx || dz) && x + dx >= 0 && x + dx <= 255 && z + dz >= 0 && within.has(n) && !ids.has(n)) out.add(n)
      }
    }
  }
  return out
}

/** `--only` items: 'x,z', 'x0-x1,z0-z1', separated by spaces or ';'. */
export function parseOnly(items: readonly string[]): RegionCoord[] {
  const out: RegionCoord[] = []
  for (const item of items.flatMap(s => s.split(';')).map(s => s.trim()).filter(Boolean)) {
    const p = parseRegionSpec(item)
    out.push(...regionRange(p.x0, p.x1, p.z0, p.z1))
  }
  return out
}

/**
 * The manifest as G7 compares it: without what differs between two full converts of the same input (createdAt, the
 * timings, the coast's run time, the size totals that include the manifest's own size) and with the warnings sorted.
 */
export function comparableManifest(m: WorldManifest): WorldManifest {
  const c = JSON.parse(JSON.stringify(m)) as WorldManifest
  c.createdAt = ''
  c.report.timeMs = { total: 0, terrain: 0, navmesh: 0, objects: 0, textures: 0 }
  c.report.sizes.totalBytes = 0
  delete c.report.sizes.byCategory.manifest
  if (c.report.coast && typeof c.report.coast === 'object' && 'timeS' in c.report.coast) (c.report.coast as Record<string, unknown>).timeS = 0
  c.warnings = [...c.warnings].sort()
  return c
}

// --- the coast snapshot ----------------------------------------------------------------------------------------------

export const COAST_SNAPSHOT_FORMAT = 'sro-coast-snapshot'
export const COAST_SNAPSHOT_VERSION = 1

/** A typed array as JSON. */
type Packed = { $: string; b: string }
const TYPED: Record<string, { new (b: ArrayBuffer): ArrayLike<number> }> = {
  Float32Array, Int32Array, Uint16Array, Uint8Array, Float64Array, Int16Array, Uint32Array, Int8Array,
}
const pack = (_k: string, v: unknown): unknown => {
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const name = v.constructor.name
    if (!TYPED[name]) throw new Error(`coast snapshot: cannot pack ${name}`)
    return { $: name, b: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') } satisfies Packed
  }
  return v
}
const unpack = (_k: string, v: unknown): unknown => {
  if (v && typeof v === 'object' && '$' in v && 'b' in v && typeof (v as Packed).$ === 'string' && Object.keys(v).length === 2) {
    const p = v as Packed
    const T = TYPED[p.$]
    if (!T) throw new Error(`coast snapshot: unknown array type ${p.$}`)
    const bytes = Buffer.from(p.b, 'base64')
    const copy = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(copy).set(bytes)
    return new T(copy)
  }
  return v
}

/** The post-coast .nvm of a region as the keys that differ from its retail .nvm (the edges rarely change). */
export type NvmDiff = Partial<Record<keyof NvmFile, unknown>>

export function diffNvm(edited: NvmFile, retail: NvmFile): NvmDiff {
  const out: NvmDiff = {}
  for (const k of new Set([...Object.keys(edited), ...Object.keys(retail)]) as Set<keyof NvmFile>) {
    const a = JSON.stringify(edited[k], pack)
    if (a !== JSON.stringify(retail[k], pack)) out[k] = edited[k] === undefined ? null : edited[k]
  }
  return out
}

export function applyNvmDiff(retail: NvmFile, diff: NvmDiff): NvmFile {
  const out = { ...retail } as Record<string, unknown>
  for (const [k, v] of Object.entries(diff)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out as unknown as NvmFile
}

/** What the incremental convert replays instead of running the coast (the coast's outputs that no edit changes). */
export interface CoastSnapshot {
  format: typeof COAST_SNAPSHOT_FORMAT
  version: typeof COAST_SNAPSHOT_VERSION
  /** The inputs' fingerprint (coastSnapshotKey). */
  key: string
  name: string
  /** Region ids: emitted (synthetic), changed by the coast (terrain), minimaps redrawn over C9's drops. */
  synthetic: number[]
  changed: number[]
  dropRedrawn: number[]
  /** Region id -> the post-coast .nvm as a diff of the retail one (every region the coast re-navigates). */
  nav: Record<string, NvmDiff>
  /** C9 on the pre-pass placements, and the warnings it pushed. */
  c9: PlacementEdits
  c9Warnings: string[]
  manifestCoast: WorldCoast | null
  /** report.coast before the passes add `placements` (its s1Link is replaced by the run's). */
  report: Record<string, unknown>
  /** The warnings the coast pushed while it was created. */
  createWarnings: string[]
  typeNames: Array<[number, string]>
  places: Array<{ name: string; x: number; z: number }>
  seaLevelM: number
}

function sha256(...parts: Array<string | Uint8Array>): string {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest('hex')
}

/**
 * The fingerprint of the coast's inputs: this format, the export's frame and region rectangle, coast.json and every
 * file beside it (the coast's own sourceHash rule), the coast's code and the format parsers, the pre-pass cache (C9 reads
 * its placements) and the retail archives' sizes and times. Any change makes the incremental run the coast again.
 */
export function coastSnapshotKey(input: {
  name: string; preset: WorldPreset; configFile: string; prePassBytes: Uint8Array; cfg: SroConfig
}): string {
  const { preset } = input
  const parts: Array<string | Uint8Array> = [
    `${COAST_SNAPSHOT_FORMAT} v${COAST_SNAPSHOT_VERSION}`, input.name,
    JSON.stringify([preset.x0, preset.x1, preset.z0, preset.z1, preset.centre, preset.playable ?? null, preset.stream ?? false]),
  ]
  const dir = dirname(input.configFile)
  parts.push(readFileSync(input.configFile))
  for (const f of listFiles(dir)) {
    if (join(dir, f) === input.configFile) continue
    parts.push(f, readFileSync(join(dir, f)))
  }
  for (const code of [join(REPO_ROOT, 'packages', 'convert', 'src', 'world', 'coast'), join(REPO_ROOT, 'packages', 'formats', 'src')]) {
    for (const f of listFiles(code)) parts.push(f, readFileSync(join(code, f)))
  }
  parts.push(sha256(input.prePassBytes))
  for (const a of ['Map', 'Data', 'Media']) {
    const file = join(input.cfg.clientDir, `${a}.pk2`)
    if (existsSync(file)) {
      const s = statSync(file)
      parts.push(`${a} ${s.size} ${s.mtimeMs}`)
    }
  }
  return sha256(...parts)
}

export function encodeCoastSnapshot(s: CoastSnapshot): string {
  return JSON.stringify(s, pack) + '\n'
}

export function parseCoastSnapshot(text: string): CoastSnapshot {
  const s = JSON.parse(text, unpack) as Partial<CoastSnapshot>
  if (s.format !== COAST_SNAPSHOT_FORMAT || s.version !== COAST_SNAPSHOT_VERSION) {
    throw new Error(`coast snapshot: expected ${COAST_SNAPSHOT_FORMAT} v${COAST_SNAPSHOT_VERSION}`)
  }
  return s as CoastSnapshot
}

// --- the staging export ----------------------------------------------------------------------------------------------

/** Folders the passes rewrite whole: never hard-linked before the passes (the coast's field, the tree species). */
export const NOT_LINKED = [/^coast\//, new RegExp(`^${speciesFolder('').replace(/\/$/, '')}/`)]

/** The staging export (see the header): links, temp + rename writes, the check of the live files behind the links. */
export class Staging {
  readonly written = new Set<string>()
  readonly removed = new Set<string>()
  private readonly linkedStats = new Map<string, { size: number; mtimeMs: number }>()

  constructor(readonly live: string, readonly dir: string) {}

  path(rel: string): string {
    return join(this.dir, ...rel.split('/'))
  }

  /** Fresh: the old staging folder is removed (its links only), then every live file but NOT_LINKED is linked in. */
  init(): void {
    if (resolve(this.dir) === resolve(this.live)) throw new Error('convert-region: the staging folder is the live export')
    rmSync(this.dir, { recursive: true, force: true })
    mkdirSync(this.dir, { recursive: true })
    for (const rel of listFiles(this.live)) {
      if (NOT_LINKED.some(r => r.test(rel))) continue
      this.linkIn(rel)
    }
  }

  private linkIn(rel: string): void {
    const to = this.path(rel)
    mkdirSync(dirname(to), { recursive: true })
    const from = join(this.live, ...rel.split('/'))
    const s = statSync(from)
    try {
      linkSync(from, to)
      this.linkedStats.set(rel, { size: s.size, mtimeMs: s.mtimeMs })
    } catch {
      copyFileSync(from, to) // a file system without hard links: a copy is as safe, only slower
    }
  }

  /** The live file's bytes, or null. */
  liveBytes(rel: string): Buffer | null {
    const f = join(this.live, ...rel.split('/'))
    return existsSync(f) ? readFileSync(f) : null
  }

  /** Writes by temp + rename (a link at the path is replaced, the live file is not touched). */
  put(rel: string, bytes: Uint8Array | string): void {
    const file = this.path(rel)
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, file)
    this.written.add(rel)
    this.removed.delete(rel)
  }

  /** put() unless the live file has the same bytes (the link stays). Returns the byte count. */
  emit(rel: string, bytes: Uint8Array | string): number {
    const buf = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
    const old = this.liveBytes(rel)
    const inStaging = existsSync(this.path(rel))
    if (!old || !Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).equals(old) || !inStaging || this.written.has(rel)) this.put(rel, buf)
    return buf.byteLength
  }

  /** Removes a path from the staging folder (a link or a file); a pass then writes a new file there. */
  unlink(rel: string): void {
    const file = this.path(rel)
    if (existsSync(file)) unlinkSync(file)
  }

  /** The export no longer has the file. */
  remove(rel: string): void {
    this.unlink(rel)
    this.removed.add(rel)
    this.written.delete(rel)
  }

  size(rel: string): number {
    return statSync(this.path(rel)).size
  }

  /**
   * Links in every live file the run did not write or remove, checks the live files behind the links, and returns the
   * changed files (bytes differ from the live export, or new) and the removed ones.
   */
  finish(): { changed: string[]; removed: string[] } {
    const liveFiles = listFiles(this.live)
    const have = new Set(listFiles(this.dir))
    for (const rel of liveFiles) if (!have.has(rel) && !this.removed.has(rel)) this.linkIn(rel)
    const broken: string[] = []
    for (const [rel, s] of this.linkedStats) {
      const now = statSync(join(this.live, ...rel.split('/')), { throwIfNoEntry: false })
      if (!now || now.size !== s.size || now.mtimeMs !== s.mtimeMs) broken.push(rel)
    }
    if (broken.length) {
      throw new Error(`convert-region: ${broken.length} live file(s) changed while hard-linked into the staging export ` +
        `(a write through a link, or another process): ${broken.slice(0, 5).join(', ')}${broken.length > 5 ? ', ...' : ''}`)
    }
    const changed: string[] = []
    const liveSet = new Set(liveFiles)
    for (const rel of listFiles(this.dir)) {
      if (rel.endsWith('.tmp')) continue
      if (!liveSet.has(rel)) {
        changed.push(rel)
        continue
      }
      const a = statSync(this.path(rel), { bigint: true })
      const b = statSync(join(this.live, ...rel.split('/')), { bigint: true })
      if (a.ino === b.ino && a.dev === b.dev) continue
      if (a.size !== b.size || !readFileSync(this.path(rel)).equals(readFileSync(join(this.live, ...rel.split('/'))))) changed.push(rel)
    }
    // a removed path a pass wrote again (by any route) is a changed file, not a removed one
    return { changed: changed.sort(), removed: [...this.removed].filter(r => liveSet.has(r) && !existsSync(this.path(r))).sort() }
  }
}

// --- warnings kept from the live export ------------------------------------------------------------------------------

/**
 * Which step wrote a live warning: 'regen' (a step this run repeats: dropped, the run's own are used), a region id (the
 * terrain step's per-region warnings: dropped for the work set), or 'keep' (a step this run does not repeat: the
 * objects, tiles, water and environment steps).
 */
export function warningSource(line: string): 'regen' | 'keep' | number {
  const region = /^region (\d+),(\d+)\b/.exec(line)
  if (region) return (Number(region[2]) << 8) | Number(region[1])
  const file = /^(\d+)\/(\d+)\.(m|t)\b/.exec(line)
  if (file) return (Number(file[1]) << 8) | Number(file[2])
  const minimap = /^(?:worldmap )?minimap\/(\d+)x(\d+)\.ddj\b/.exec(line)
  if (minimap) return (Number(minimap[2]) << 8) | Number(minimap[1])
  if (/^(nav: |navmesh\/nv_|spawn: |stream: |places: |coast(?: check)?: |town(?: dressing)?: |cloth: |static variant|grass palette|edits: |world edits|tree swap: |ambient: )/.test(line)) {
    return 'regen'
  }
  if (line.startsWith(`${TELEPORTDATA_PATH}:`)) return 'regen'
  return 'keep'
}

// --- the run ---------------------------------------------------------------------------------------------------------

const mb = (n: number) => (n / 2 ** 20).toFixed(2)

/** The incremental convert (see the header). The CLI takes the convert lock around it. */
export async function convertRegions(opts: ConvertRegionsOptions): Promise<ConvertRegionsResult> {
  const t0 = performance.now()
  const timeMs: Record<string, number> = {}
  let tStep = t0
  const lap = (k: string) => {
    const now = performance.now()
    timeMs[k] = Math.round(now - tStep)
    tStep = now
  }
  const log = opts.log ?? (() => {})
  const name = opts.world
  const preset = opts.preset ?? WORLD_PRESETS[name]
  if (!preset) throw new Error(`convert-region: unknown world ${JSON.stringify(name)}; expected one of ${Object.keys(WORLD_PRESETS).join(', ')}`)
  const cfg = opts.cfg ?? loadConfig()
  const liveDir = resolve(opts.liveDir ?? join(cfg.workDir, 'out', 'world', name))
  const stagingDir = resolve(opts.stagingDir ?? `${liveDir}-edit`)
  const cacheDir = join(cfg.workDir, 'cache', 'world', name)
  const prePassFile = opts.prePassCache ?? join(cacheDir, 'prepass.json')
  const snapshotFile = opts.snapshot === null ? null : opts.snapshot ?? join(dirname(prePassFile), 'coast-snapshot.json')
  const recordFile = opts.record === null ? null : opts.record ?? join(dirname(prePassFile), 'incremental.json')
  const repoPath = (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p))

  if (!existsSync(join(liveDir, 'manifest.json'))) throw new Error(`convert-region: no live export at ${liveDir} (run a full convert first)`)
  if (!existsSync(prePassFile)) throw new Error(`convert-region: no pre-pass cache at ${prePassFile} (a full convert writes it)`)
  const live = JSON.parse(readFileSync(join(liveDir, 'manifest.json'), 'utf8')) as WorldManifest
  const prePassBytes = readFileSync(prePassFile)
  const pre = parsePrePassCache(prePassBytes.toString('utf8'), name)
  const origin = preset.centre
  if (live.name !== name) throw new Error(`convert-region: the live export is '${live.name}', expected '${name}'`)
  if (pre.origin.x !== origin.x || pre.origin.z !== origin.z || live.space.originRegion.x !== origin.x || live.space.originRegion.z !== origin.z) {
    throw new Error('convert-region: the pre-pass cache, the live export and the preset disagree on the origin')
  }

  const data = openArchive('Data', cfg)
  const map = openArchive('Map', cfg)
  const media = openArchive('Media', cfg)
  const mfo = parseMfo(map.read('mapinfo.mfo'))
  const tile2d = parseTile2d(map.read('tile2d.ifo'))
  const exportRegions = regionRange(preset.x0, preset.x1, preset.z0, preset.z1)
  const playableRect = preset.playable ?? (preset.stream ? rectOf(exportRegions) : undefined)
  const liveIds = new Set(live.regions.map(r => r.id))
  /** The regions' warnings and the run's, in step order; the live export's kept ones are merged in at the end. */
  const warnings: string[] = []

  // --- the edits run, the work set ------------------------------------------------------------------------------------
  const editsDir = opts.edits === null ? null : opts.edits ?? preset.edits ?? null
  const staging = new Staging(liveDir, stagingDir)
  staging.init()
  // the edits' grass masks and sound zones are written again by the edits run (every region's extras, the pass's zones):
  // never through a link, and gone unless the run writes them again (a revert, a base convert: H12-INC-1, H12-INC-2)
  for (const r of live.regions) if (r.grassMask) staging.remove(r.grassMask)
  staging.remove(SOUND_ZONES_FILE)
  const coastWarnings: string[] = []
  const editWarnings: string[] = []
  const editsRun: WorldEditsRun | null = opts.editsRun !== undefined
    ? opts.editsRun
    : editsDir
      ? await createWorldEdits({
        dir: repoPath(editsDir), world: name, outDir: stagingDir, origin, regions: exportRegions, warnings: editWarnings, log,
        prePass: { placements: pre.placements, models: pre.models, live: live.placements, liveReport: live.report },
        ...(playableRect ? { playable: playableRect } : {}),
        // the coast field the nav step reads: the coast's own when it runs here (the nav step comes after it), else the
        // live export's (edit-independent; the snapshot replays it)
        coastField: () => {
          const c = coast?.manifestCoast?.()
          if (c) return { file: join(stagingDir, ...c.field.file.split('/')), field: c.field }
          return live.coast ? { file: join(liveDir, ...live.coast.field.file.split('/')), field: live.coast.field } : null
        },
      })
      : null
  const touched = new Set<number>(editsRun?.touched ?? [])
  const record = recordFile && existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) as { prePass: string; core: number[] } : null
  const prePassHash = sha256(prePassBytes)
  const carried = record && record.prePass === prePassHash ? record.core : []
  const core = new Set<number>()
  for (const r of opts.only) {
    const id = idOf(r)
    if (!liveIds.has(id)) throw new Error(`convert-region: region ${id & 0xff},${id >> 8} is not in the export`)
    core.add(id)
  }
  for (const id of [...touched, ...carried]) if (liveIds.has(id)) core.add(id)
  const ring = ringOf(core, liveIds)
  const work = new Set([...core, ...ring])
  log(`convert-region ${name}: core ${core.size} region(s) (${[...core].map(i => `${i & 0xff},${i >> 8}`).join(' ') || 'none'}), ring ${ring.size}`)

  // --- the coast: none, the snapshot, or a run -------------------------------------------------------------------------
  let coast: CoastRun | null = null
  let snap: CoastSnapshot | null = null
  let coastMode: ConvertRegionsResult['coast'] = 'none'
  let snapKey = ''
  const configFile = preset.coast ? repoPath(preset.coast) : null
  const syntheticIds = new Set(live.regions.filter(r => r.synthetic).map(r => r.id))
  if (configFile) {
    if (snapshotFile && opts.coast !== 'run') {
      snapKey = coastSnapshotKey({ name, preset, configFile, prePassBytes, cfg })
      if (existsSync(snapshotFile)) {
        try {
          const s = parseCoastSnapshot(readFileSync(snapshotFile, 'utf8'))
          if (s.key === snapKey && s.name === name) snap = s
          else log('coast snapshot: stale (the coast, its content or the pre-pass cache changed)')
        } catch (e) {
          log(`coast snapshot: unreadable (${(e as Error).message})`)
        }
      }
    }
    if (snap) {
      // the coast is needed where it changed or emitted the terrain (and their ring: the normals read its heights), or
      // redrew a minimap over C9's drops
      const terrainCoast = new Set([...snap.synthetic, ...snap.changed])
      const near = new Set([...terrainCoast, ...ringOf(terrainCoast, new Set([...liveIds, ...syntheticIds]))])
      const hit = [...work].filter(id => near.has(id) || snap!.dropRedrawn.includes(id))
      if (hit.length) {
        log(`coast: the work set reaches the coast at ${hit.slice(0, 6).map(i => `${i & 0xff},${i >> 8}`).join(' ')}${hit.length > 6 ? ' ...' : ''}; running it`)
        snap = null
      }
    }
    if (snap) coastMode = 'snapshot'
    else {
      coastMode = 'run'
      snapKey ||= snapshotFile ? coastSnapshotKey({ name, preset, configFile, prePassBytes, cfg }) : ''
    }
  }
  lap('setup')
  if (coastMode === 'run') {
    const retailRegion = (x: number, z: number) => {
      const path = `${z}/${x}.m`
      if (x < 0 || x > 255 || z < 0 || z > 127 || !map.has(path)) return null
      const mapm = parseMapM(map.read(path))
      return { mapm, grid: assembleRegionGrid(mapm) }
    }
    staging.unlink('coast/field.png')
    coast = await createCoastPass({
      configFile: configFile!, outDir: stagingDir, origin, regions: exportRegions, playable: playableRect, cfg, warnings: coastWarnings, log,
      readRegion: retailRegion, active: (x, z) => isRegionActive(mfo, x, z), tileType: id => tile2d.byId.get(id)?.typeName ?? null,
    })
    for (const f of listFiles(join(stagingDir, 'coast'))) staging.written.add(`coast/${f}`)
    lap('coast')
  }
  const createWarnings = coast ? coastWarnings.slice() : snap ? snap.createWarnings.slice() : []

  // --- terrain: the work set's regions, as convertWorld's terrain step --------------------------------------------------
  const retailCache = new Map<number, { mapm: MapMFile; grid: RegionGrid } | null>()
  const mapmCache = new Map<number, { mapm: MapMFile; grid: RegionGrid; synthetic?: boolean } | null>()
  const loadRetail = (x: number, z: number) => {
    const id = (z << 8) | x
    if (!retailCache.has(id)) {
      let entry: { mapm: MapMFile; grid: RegionGrid } | null = null
      const path = `${z}/${x}.m`
      if (x >= 0 && x <= 255 && z >= 0 && z <= 127 && isRegionActive(mfo, x, z) && map.has(path)) {
        try {
          const mapm = parseMapM(map.read(path))
          entry = { mapm, grid: assembleRegionGrid(mapm) }
        } catch (e) {
          warnings.push(`${path}: ${(e as Error).message}`)
        }
      }
      retailCache.set(id, entry)
    }
    return retailCache.get(id)!
  }
  const loadRegion = (x: number, z: number) => {
    const id = (z << 8) | x
    if (!mapmCache.has(id)) {
      const base = coast ? coast.source.terrain(x, z, loadRetail(x, z)) : loadRetail(x, z)
      mapmCache.set(id, editsRun?.terrain && touched.has(id) ? editsRun.terrain(x, z, base) : base)
    }
    return mapmCache.get(id)!
  }
  const globalHeight = (ggx: number, ggz: number): number | undefined => {
    if (ggx < 0 || ggz < 0) return undefined
    const edited = editsRun?.height?.(ggx, ggz)
    if (edited !== undefined) return edited
    const own = coast?.source.height(ggx, ggz)
    if (own !== undefined) return own
    const rx = Math.floor(ggx / CELLS)
    const rz = Math.floor(ggz / CELLS)
    const r = loadRetail(rx, rz)
    return r ? r.grid.heights[(ggz - rz * CELLS) * 97 + (ggx - rx * CELLS)] : undefined
  }
  const retailMinimap = (x: number, z: number): RgbaImage | null => {
    const path = `minimap/${x}x${z}.ddj`
    if (!media.has(path)) return null
    try {
      return decodeDds(parseDdj(media.read(path)).dds)
    } catch (e) {
      warnings.push(`${path}: ${(e as Error).message}`)
      return null
    }
  }
  let minimapOpts = coast ? coastMinimapOptions(coast.config) : null
  const coastTiles = new Map<number, CoastMinimapTile>()
  const editLightmaps = new Map<number, EditsImage>()
  const pngOut = (rel: string, img: { width: number; height: number; rgba: Uint8Array }) => staging.emit(rel, encodePng(img.width, img.height, img.rgba))
  const newEntries = new Map<number, WorldRegion>()
  const regionWarnings = new Map<number, string[]>()
  // the edited regions load first, so a neighbour built earlier reads every edited vertex on its border (normals: the
  // edits' height() knows a region's edited lattice only once its terrain() ran; before that globalHeight falls back to
  // the unedited ground and the border normals differ from the full convert's, convert-world.ts does the same: G7)
  for (const r of live.regions) if (touched.has(r.id)) loadRegion(r.x, r.z)
  for (const r of live.regions) {
    if (!work.has(r.id)) continue
    const { x, z } = r
    const before = warnings.length
    const loaded = loadRegion(x, z)
    if (!loaded) throw new Error(`convert-region: region ${x},${z} is in the live export but did not load now (the export is older than the data)`)
    const { mapm, grid } = loaded
    const layers = buildLayers(mapm)
    if (layers.overflowCells) warnings.push(`region ${x},${z}: ${layers.overflowCells} cell(s) exceed ${8} layers`)
    if (grid.edgeConflicts.length) warnings.push(`region ${x},${z}: ${grid.edgeConflicts.length} block-edge height conflict(s) (later block wins)`)
    const heights = heightsToMetres(grid.heights)
    const bin = encodeTerrainBin({ layerCount: layers.layerCount, heights, normals: buildNormals(x, z, globalHeight), textures: grid.textures, layers: layers.layers })
    const terrainFile = `terrain/${x}_${z}.bin`
    staging.emit(terrainFile, bin)
    let hMin = Infinity
    let hMax = -Infinity
    for (const h of heights) {
      hMin = Math.min(hMin, h)
      hMax = Math.max(hMax, h)
    }
    hMin = roundM(hMin)
    hMax = roundM(hMax)
    const tileIds = [...new Set(grid.textureIds)].sort((a, b) => a - b)
    const blocks = mapm.blocks.map(blockEntry)
    const synthetic = loaded.synthetic === true
    let lightmap: WorldRegion['lightmap'] = r.lightmap
    let minimap: string | null = r.minimap
    if (core.has(r.id)) {
      // the core's lightmap and minimap, as convertWorld's terrain step (the ring keeps its own: nothing changed them)
      const madeUp = synthetic && !coast?.source.isLookOnly(x, z)
      lightmap = null
      const tPath = `${z}/${x}.t`
      if (madeUp) {
        const img = coast ? bakeRegionLightmap(coast.result, coast.retail.heights, x, z, null) : null
        if (img) {
          const file = `terrain/${x}_${z}_lightmap.png`
          pngOut(file, img)
          lightmap = { file, width: img.width, height: img.height }
          if (touched.has(r.id)) editLightmaps.set(r.id, img)
        }
      } else if (map.has(tPath)) {
        try {
          const retailImg = decodeMapTLightmap(parseMapT(map.read(tPath)))
          const img = (coast && coast.source.changed(x, z, loadRetail(x, z)) ? bakeRegionLightmap(coast.result, coast.retail.heights, x, z, retailImg) : null) ?? retailImg
          const file = `terrain/${x}_${z}_lightmap.png`
          pngOut(file, img)
          lightmap = { file, width: img.width, height: img.height }
          if (touched.has(r.id) && img.rgba) editLightmaps.set(r.id, { width: img.width, height: img.height, rgba: img.rgba })
        } catch (e) {
          warnings.push(`${tPath}: ${(e as Error).message}`)
        }
      } else warnings.push(`${tPath}: missing (render the region unlit / white lightmap)`)
      minimap = null
      const mmPath = `minimap/${x}x${z}.ddj`
      const coastTile = coast && minimapOpts && (madeUp || coast.source.changed(x, z, loadRetail(x, z)))
        ? coastMinimapTile(coast.result, coast.retail.heights, x, z, madeUp ? null : retailMinimap(x, z), minimapOpts)
        : null
      if (coastTile && coastTile.kind !== 'retail') {
        const rel = `minimap/${x}x${z}.png`
        pngOut(rel, coastTile)
        coastTiles.set(r.id, coastTile)
        minimap = rel
      } else if (!madeUp && media.has(mmPath)) {
        try {
          const rel = `minimap/${x}x${z}.png`
          const img = decodeDds(parseDdj(media.read(mmPath)).dds)
          pngOut(rel, img)
          minimap = rel
        } catch (e) {
          warnings.push(`${mmPath}: ${(e as Error).message}`)
        }
      }
    }
    const o = regionOrigin(r, origin)
    const far = toGltfPosition([REGION_UNITS, 0, REGION_UNITS])
    newEntries.set(r.id, {
      x, z, id: r.id, origin: o,
      bounds: {
        min: [Math.min(o[0], o[0] + far[0]), hMin, Math.min(o[2], o[2] + far[2])],
        max: [Math.max(o[0], o[0] + far[0]), hMax, Math.max(o[2], o[2] + far[2])],
      },
      terrain: { file: terrainFile, bytes: bin.byteLength, heightMinM: hMin, heightMaxM: hMax, layerCount: layers.layerCount, tileIds },
      lightmap,
      minimap,
      blocks,
      navmesh: null,
      ...(synthetic ? { synthetic: true as const } : {}),
    })
    regionWarnings.set(r.id, warnings.splice(before))
  }
  // the export's region entries as the passes see them: the work set's new ones, the others' with the extras removed
  // (the edits' regionExtras writes them again for every region after the passes)
  const regions: WorldRegion[] = live.regions.map(r => {
    const n = newEntries.get(r.id)
    if (n) return n
    const { grassMask: _g, lightPoints: _l, ...rest } = JSON.parse(JSON.stringify(r)) as WorldRegion
    return { ...rest, navmesh: null }
  })
  lap('terrain')

  // --- navigation: every region (retail .nvm -> the coast's edit -> the edits' navEdit) ---------------------------------
  const navWarnings: string[] = []
  const navInputs: Array<{ id: number; nvm: NvmFile }> = []
  const navChanged = new Set<number>()
  const snapNav: Record<string, NvmDiff> = {}
  for (const region of regions) {
    if (region.synthetic) continue
    const path = `navmesh/nv_${region.id.toString(16).padStart(4, '0')}.nvm`
    if (!data.has(path)) {
      navWarnings.push(`${path}: missing`)
      continue
    }
    try {
      const retail = parseNvm(data.read(path))
      let nvm = retail
      if (coast) {
        const edit = coast.source.navEdit(region.x, region.z, loadRetail(region.x, region.z))
        if (edit) {
          const edited = editRegionNav(nvm, edit)
          nvm = edited.nvm
          coast.noteNav(edited.stats)
          snapNav[region.id] = diffNvm(nvm, retail)
        }
      } else if (snap?.nav[region.id]) nvm = applyNvmDiff(retail, snap.nav[region.id]!)
      const editedNvm = editsRun?.navEdit?.(region.id, nvm)
      if (editedNvm) {
        nvm = editedNvm
        navChanged.add(region.id)
      }
      navInputs.push({ id: region.id, nvm })
      const cells = new Float32Array(nvm.cells.length * 4)
      nvm.cells.forEach((c, i) => cells.set([c.minX, c.minZ, c.maxX, c.maxZ], i * 4))
      const edgesAll = [...nvm.globalEdges, ...nvm.internalEdges]
      const edges = new Float32Array(edgesAll.length * 4)
      const edgeFlags = new Uint8Array(edgesAll.length)
      edgesAll.forEach((e, i) => {
        edges.set([e.ax, e.az, e.bx, e.bz], i * 4)
        edgeFlags[i] = e.flag
      })
      const bin = encodeNavmeshBin({
        openCellCount: nvm.openCellCount, globalEdgeCount: nvm.globalEdges.length, heights: heightsToMetres(nvm.heights),
        tileCells: nvm.tileCells, cells, edges, tileFlags: nvm.tileFlags, edgeFlags,
      })
      const file = `navmesh/${region.x}_${region.z}.bin`
      staging.emit(file, bin)
      region.navmesh = {
        file, bytes: bin.byteLength, cells: nvm.cells.length, openCells: nvm.openCellCount, globalEdges: nvm.globalEdges.length,
        internalEdges: nvm.internalEdges.length, objects: nvm.objects.length,
        planes: nvm.planeTypes && nvm.planeHeights
          ? [...nvm.planeTypes].map((type, i) => ({ type, heightM: roundM(nvm.planeHeights![i]! * UNIT_SCALE) }))
          : null,
      }
    } catch (e) {
      navWarnings.push(`${path}: ${(e as Error).message}`)
    }
  }
  warnings.push(...navWarnings)
  lap('navmesh')

  let nav: WorldNav | undefined
  let spawn: WorldSpawn | undefined
  let navData: NavData | undefined
  let navWorld: NavWorld | undefined
  let s1Link: { reachable: boolean; opened: number } | null = null
  if (navInputs.length) {
    try {
      const built = buildWorldNav(navInputs, p => (data.has(p) ? data.read(p) : undefined), warnings)
      navData = built.data
      const bytes = staging.emit(NAV_FILE, built.bytes)
      nav = { file: NAV_FILE, bytes, ...built.info }
      if (!media.has(TELEPORTDATA_PATH)) warnings.push(`${TELEPORTDATA_PATH}: missing (no spawn)`)
      else {
        const teleport = pickSpawnTeleport(parseTeleportData(media.read(TELEPORTDATA_PATH)), new Set(nav.regions), preset.spawnTeleport)
        if (!teleport) warnings.push(`spawn: no ${preset.spawnTeleport ?? 'return point'} in teleportdata.txt within the converted regions`)
        else {
          navWorld = new NavWorld(built.data)
          const r = spawnFromTeleport(navWorld, teleport, origin)
          if ('error' in r) warnings.push(`spawn: ${r.error}`)
          else {
            spawn = r.spawn
            const home = { x: origin.x * 1920 + spawn.x * 10, y: spawn.y * 10, z: origin.z * 1920 - spawn.z * 10 }
            if (coast) coast.checkLink(built.data, home)
            else if (snap) {
              // the coast's S1 check (./coast/hook.ts checkLink) on the new nav
              const world = new NavWorld(closeRing(built.data, playableRect ?? rectOf(exportRegions)))
              const reachable = reachesBothWays(world, { x: S1_POINT[0] * 1920, z: S1_POINT[1] * 1920 }, home)
              const navStats = snap.report.nav as { opened?: number } | undefined
              s1Link = { reachable, opened: navStats?.opened ?? 0 }
              if (!reachable) warnings.push('coast check: S1 does not reach the town with the ring closed (its openTiles link is broken, docs/COAST.md §3.5 G1)')
            }
          }
        }
      }
    } catch (e) {
      warnings.push(`nav: ${(e as Error).message}`)
    }
  }
  lap('nav')

  // --- the stream's nav files (the splice: only the chunks whose bytes changed), places --------------------------------
  const drift: string[] = []
  let navRegionBytes = 0
  let navObjectBytes = 0
  if (preset.stream) {
    if (navData) {
      const split = splitWorldNav(navData)
      for (const c of split.regions) {
        const old = staging.liveBytes(c.file)
        if (old && !Buffer.from(c.bytes).equals(old) && !work.has(c.id) && !navChanged.has(c.id)) drift.push(c.file)
        navRegionBytes += staging.emit(c.file, c.bytes)
      }
      navObjectBytes = staging.emit(NAV_OBJECTS_FILE, split.objects)
    } else warnings.push('stream: no nav.bin, so no nav chunks')
  }
  for (const r of regions) {
    if (!r.navmesh || work.has(r.id) || navChanged.has(r.id) || !staging.written.has(r.navmesh.file)) continue
    drift.push(r.navmesh.file)
  }
  let places: WorldPlace[] | undefined
  if (preset.places) {
    const dir = 'server_dep/silkroad/textdata'
    if (!navWorld || !spawn) warnings.push('places: need nav.bin and a spawn; none written')
    else {
      try {
        const table = loadTextdataTable('textzonename.txt', f => (media.has(`${dir}/${f}`) ? media.read(`${dir}/${f}`) : undefined))
        places = buildPlaces({
          world: navWorld, origin, spawn, zoneNames: zoneNameIndex(table.rows.map(r => r.cells), table.header), regions, playable: playableRect, warnings,
        })
        const own = coast ? coast.places(navWorld, origin) : snap ? coastPlaces(snap, navWorld, origin, warnings) : null
        if (own) places = [...places.filter(p => !own.some(q => q.name === p.name)), ...own]
      } catch (e) {
        warnings.push(`places: ${(e as Error).message}`)
      }
    }
  }
  lap('stream')

  // --- tiles (new ones only: the others are the pre-pass cache's), environment, town files -----------------------------
  const usedTiles = new Set<number>()
  const usedProfiles = new Set<number>()
  for (const r of regions) {
    for (const id of r.terrain.tileIds) usedTiles.add(id)
    for (const b of r.blocks) usedProfiles.add(b.environmentId)
  }
  const preTiles = new Map(pre.tiles.map(t => [t.id, t]))
  const typeNames = coast ? coast.typeNames() : snap ? new Map(snap.typeNames) : null
  let tiles: TileTexture[] = []
  for (const id of [...usedTiles].sort((a, b) => a - b)) {
    const known = preTiles.get(id)
    if (known) {
      tiles.push(known)
      continue
    }
    const entry = tile2d.byId.get(id)
    if (!entry) {
      warnings.push(`tile2d.ifo has no id ${id}`)
      continue
    }
    const rel = `tiles/${entry.file.toLowerCase().replace(/\.ddj$/, '')}.png`
    try {
      const img = decodeDds(parseDdj(map.read(entry.path)).dds)
      staging.emit(rel, encodePng(img.width, img.height, img.rgba))
      const t: TileTexture = { id, source: entry.file, file: rel, width: img.width, height: img.height, typeName: entry.typeName ?? null, category: entry.category }
      tiles.push(typeNames?.has(id) ? { ...t, typeName: typeNames.get(id)! } : t)
    } catch (e) {
      warnings.push(`tile ${id} ${entry.path}: ${(e as Error).message}`)
    }
  }
  const profileIds = [...usedProfiles].sort((a, b) => a - b)
  if (profileIds.join() !== live.environment.profileIds.join()) {
    // the editor never changes a block's profile: environment.json is the live one, or the export is not this code's
    throw new Error(`convert-region: the environment profiles changed (${live.environment.profileIds.join(',')} -> ${profileIds.join(',')}); run a full convert`)
  }
  const townContent = preset.town ? loadTownContent(preset.town, name, warnings, log) : null
  let town: WorldManifest['town']
  if (townContent) {
    if (!townContent.town) staging.remove(TOWN_FILE)
    if (!townContent.dressing) staging.remove(TOWN_DRESSING_FILE)
  }
  if (townContent && (townContent.town || townContent.dressing)) {
    if (townContent.town) staging.emit(TOWN_FILE, townContent.town.text)
    if (townContent.dressing) staging.emit(TOWN_DRESSING_FILE, townContent.dressing.text)
    town = { file: townContent.town ? TOWN_FILE : null, dressing: townContent.dressing ? TOWN_DRESSING_FILE : null }
  }
  const dressingFile = townContent?.dressing?.file ?? null
  lap('textures')

  // --- the placement passes, on the pre-pass cache ----------------------------------------------------------------------
  const withObjects = true
  let coastPass: CoastPass | null = null
  if (opts.passes?.coast !== undefined) coastPass = opts.passes.coast
  else if (coast) coastPass = coast
  else if (snap) coastPass = coastReplay(snap, () => s1Link)
  let c9Captured: { edits: PlacementEdits; warnings: string[] } | null = null
  if (coast && coastPass === coast) {
    // capture C9 for the snapshot: its edits and the warnings it pushes into the coast's list
    const real = coast
    coastPass = {
      placementEdits: async ctx => {
        const before = coastWarnings.length
        const edits = await real.placementEdits(ctx)
        c9Captured = { edits: JSON.parse(JSON.stringify(edits)) as PlacementEdits, warnings: coastWarnings.slice(before) }
        return edits
      },
      manifestCoast: () => real.manifestCoast?.(),
      report: () => real.report?.() ?? {},
    }
  }
  const liveModels = live.models
  const treesFile = preset.trees ? repoPath(preset.trees) : null
  const passWarnings: string[] = []
  const passed = await runWorldPasses({
    outDir: stagingDir, origin, regions, tiles, models: pre.models, placements: pre.placements, warnings: passWarnings, log,
  }, {
    coast: coastPass,
    townDressing: opts.passes?.townDressing !== undefined
      ? opts.passes.townDressing
      : dressingFile ? createTownDressingPass(dressingFile, stagedDressingDeps(staging, liveDir)) : null,
    cloth: opts.passes?.cloth !== undefined ? opts.passes.cloth : preset.town ? createClothPass() : null,
    staticVariants: opts.passes?.staticVariants !== undefined ? opts.passes.staticVariants : reusedStaticVariants(staging, liveModels),
    grass: opts.passes?.grass !== undefined ? opts.passes.grass : grassPalettePass,
    worldEdits: opts.passes?.worldEdits !== undefined ? opts.passes.worldEdits : editsRun?.pass ?? null,
    treeSwap: opts.passes?.treeSwap !== undefined
      ? opts.passes.treeSwap
      : treesFile
        ? createTreeSwapPass({ swapFile: treesFile, world: name, outDir: stagingDir, warnings: passWarnings, log, treesDir: join(dirname(dirname(liveDir)), 'trees') })
        : null,
  })
  // the coast's place in the warning order is before the passes' own (as in convertWorld, where they share one list)
  const coastPassWarnings = coastWarnings.slice(createWarnings.length)
  const placements: WorldPlacement[] = passed.placements
  const models: WorldModel[] = passed.models
  tiles = passed.tiles
  // files the passes wrote (fresh paths: the links were removed first)
  const scene: WorldEditsScene = { outDir: stagingDir, origin, placements, models }
  let footprintProblems: number | undefined
  const footprintWarnings: string[] = []
  if (passed.editsReport && navData) {
    const problems = editedFootprintProblems(navData, passed.editsReport.placements, placements, origin)
    footprintProblems = problems.length
    footprintWarnings.push(...problems)
  }
  lap('passes')

  // --- ambient.json -----------------------------------------------------------------------------------------------------
  let townReport = passed.townReport
  const ambientWarnings: string[] = []
  if (withObjects) {
    const particleArchive = (() => {
      try {
        return openArchive('Particles', cfg)
      } catch (e) {
        ambientWarnings.push(`ambient: Particles.pk2 unavailable (${(e as Error).message}); effects are not checked`)
        return null
      }
    })()
    const particlesOf = (m: WorldModel): ModelParticle[] | null => {
      if (!/\.bsr$/i.test(m.source)) return null
      const path = m.source.replace(/\\/g, '/')
      if (!data.has(path)) return null
      try {
        return modelParticles(parseBsr(data.read(path)), particleArchive ? k => !!particleArchive.get(k) : undefined).particles
      } catch (e) {
        ambientWarnings.push(`ambient: ${m.source}: ${(e as Error).message}`)
        return null
      }
    }
    const amb = buildAmbientIndex(models, particlesOf, dressingFile?.lamps ?? [], ambientWarnings)
    const points = editsRun?.ambientPoints?.(scene) ?? []
    staging.emit(AMBIENT_FILE, JSON.stringify(points.length ? { ...amb.index, points } : amb.index, null, 1) + '\n')
    if (dressingFile) townReport = { ...(townReport ?? { placements: { dropped: [], resnapped: [], added: [] }, models: 0, clothModels: 0 }), lampRows: amb.lampRows }
  }
  lap('ambient')

  // --- the minimap over C9's drops (a coast run only: the snapshot's redrawn regions are never in the work set) ---------
  const regionById = new Map(regions.map(r => [r.id, r]))
  const dropRedrawn: number[] = []
  const dropped = coast?.dropFootprints() ?? []
  if (coast && minimapOpts && dropped.length) {
    minimapOpts = coastMinimapOptions(coast.config, { dropped })
    for (const r of regions) {
      if (!r.minimap || !droppedTouches(dropped, r.x, r.z)) continue
      if (coastTiles.get(r.id)?.kind === 'synthetic') continue
      dropRedrawn.push(r.id)
      if (!core.has(r.id)) continue
      const retailImg = retailMinimap(r.x, r.z)
      const tileImg = retailImg && coastMinimapTile(coast.result, coast.retail.heights, r.x, r.z, retailImg, minimapOpts)
      if (!tileImg || tileImg.kind === 'retail') continue
      pngOut(r.minimap, tileImg)
      coastTiles.set(r.id, tileImg)
    }
  }

  // --- the edits after the passes: the core's lightmaps and minimaps, every region's extras ------------------------------
  const editTiles = new Map<number, RgbaImage>()
  if (editsRun) {
    for (const r of regions) {
      if (!touched.has(r.id)) continue
      const lm = editLightmaps.get(r.id)
      const baked = lm && r.lightmap ? editsRun.lightmap?.(r, lm, scene) : null
      if (baked && r.lightmap) {
        pngOut(r.lightmap.file, baked)
        r.lightmap = { file: r.lightmap.file, width: baked.width, height: baked.height }
      }
      if (editsRun.minimap) {
        const current = coastTiles.get(r.id) ?? (r.synthetic ? null : retailMinimap(r.x, r.z))
        const drawn = editsRun.minimap(r, current, scene)
        if (drawn) {
          const rel = r.minimap ?? `minimap/${r.x}x${r.z}.png`
          pngOut(rel, drawn)
          r.minimap = rel
          editTiles.set(r.id, drawn)
        }
      }
    }
    if (editsRun.regionExtras) {
      for (const r of regions) {
        const e = editsRun.regionExtras(r, scene)
        if (!e) continue
        if (e.grassMask !== undefined) r.grassMask = e.grassMask
        if (e.lightPoints !== undefined) r.lightPoints = e.lightPoints
      }
    }
  }

  // --- the world map: the core's cells re-stitched into the live image --------------------------------------------------
  let stream: WorldStream | undefined
  if (preset.stream) {
    const wm = live.stream?.worldMap
    if (!wm) throw new Error('convert-region: the live export has no world map; run a full convert')
    const fill = coast || snap ? coastWorldMapFill(passed.coast ?? undefined) : WORLD_MAP_FILL
    const cells = core
    // convertWorld's world-map tile: the edits' redraw, the coast's tile, the retail one (active), the coast's sea
    const tileFor = (r: WorldRegion): RgbaImage | null => {
      const own = editTiles.get(r.id) ?? coastTiles.get(r.id)
      if (own) return own
      if (!r.synthetic || !coast || !minimapOpts) return r.synthetic ? null : worldMapRetailTile(media, r.x, r.z, warnings)
      return coastMinimapTile(coast.result, coast.retail.heights, r.x, r.z, isRegionActive(mfo, r.x, r.z) ? retailMinimap(r.x, r.z) : null, minimapOpts)
    }
    if (cells.size) {
      const { data: raw, info } = await sharp(readFileSync(join(liveDir, ...wm.file.split('/')))).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      if (info.width !== wm.width || info.height !== wm.height || info.channels !== 4) throw new Error('convert-region: the live world map does not match its manifest entry')
      const rgba = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice()
      const px = wm.pxPerRegion
      for (const id of cells) {
        const r = regionById.get(id)!
        if (r.x < wm.x0 || r.x > wm.x1 || r.z < wm.z0 || r.z > wm.z1) continue
        const tile = tileFor(r)
        const small = tile ? boxDownsample(tile, px) : null
        const left = (r.x - wm.x0) * px
        const top = (wm.z1 - r.z) * px
        for (let y = 0; y < px; y++) {
          const at = ((top + y) * wm.width + left) * 4
          if (small) rgba.set(small.subarray(y * px * 4, (y + 1) * px * 4), at)
          else {
            for (let k = 0; k < px; k++) {
              rgba[at + k * 4] = fill[0]
              rgba[at + k * 4 + 1] = fill[1]
              rgba[at + k * 4 + 2] = fill[2]
              rgba[at + k * 4 + 3] = 255
            }
          }
        }
      }
      staging.emit(WORLD_MAP_FILE, encodePng(wm.width, wm.height, rgba))
    }
    stream = {
      playable: playableRect!,
      navRegions: { dir: NAV_REGION_DIR, bytes: navRegionBytes },
      navObjects: { file: NAV_OBJECTS_FILE, bytes: navObjectBytes },
      worldMap: { file: WORLD_MAP_FILE, pxPerRegion: wm.pxPerRegion, x0: wm.x0, x1: wm.x1, z0: wm.z0, z1: wm.z1, width: wm.width, height: wm.height },
      loadRadiusM: live.stream!.loadRadiusM,
      unloadRadiusM: live.stream!.unloadRadiusM,
    }
  }
  lap('after')

  // --- the warnings, in convertWorld's step order: the live export's kept ones merged in ---------------------------------
  const keptTerrain = new Map<number, string[]>()
  const keptOther: string[] = []
  for (const w of live.warnings) {
    const src = warningSource(w)
    if (src === 'regen') continue
    if (src === 'keep') keptOther.push(w)
    else if (!work.has(src)) (keptTerrain.get(src) ?? keptTerrain.set(src, []).get(src)!).push(w)
  }
  const terrainSection: string[] = []
  for (const r of live.regions) terrainSection.push(...(regionWarnings.get(r.id) ?? keptTerrain.get(r.id) ?? []))
  const allWarnings = [
    ...createWarnings, ...editWarnings, ...terrainSection, ...warnings, ...keptOther, ...coastPassWarnings, ...passWarnings,
    ...footprintWarnings, ...ambientWarnings,
  ]

  // --- report sizes: the categories this run can change, summed from the final files --------------------------------------
  const sizes: Record<string, number> = { ...live.report.sizes.byCategory }
  const sum = (files: Iterable<string | null | undefined>) => {
    let n = 0
    for (const f of files) if (f) n += staging.size(f)
    return n
  }
  const setSize = (k: string, n: number) => {
    if (n || k in sizes) sizes[k] = n
  }
  setSize('terrain', regions.reduce((s, r) => s + r.terrain.bytes, 0))
  setSize('lightmaps.terrain', sum(regions.map(r => r.lightmap?.file)))
  setSize('minimap', sum(regions.map(r => r.minimap)))
  setSize('navmesh', regions.reduce((s, r) => s + (r.navmesh?.bytes ?? 0), 0))
  if (nav) setSize('nav', nav.bytes)
  if (preset.stream && navData) {
    setSize('nav.regions', navRegionBytes)
    setSize('nav.objects', navObjectBytes)
  }
  if (stream?.worldMap) setSize('worldmap', staging.size(stream.worldMap.file))
  setSize('tiles', sum(tiles.map(t => t.file)))
  if (town) setSize('town', sum([town.file, town.dressing]))
  else delete sizes.town
  if (existsSync(staging.path(AMBIENT_FILE))) setSize('ambient', staging.size(AMBIENT_FILE))

  // --- the manifest (convertWorld's shape and key order) --------------------------------------------------------------
  let compoundPlacements = live.report.compoundPlacements
  if (coastPass) compoundPlacements = placements.filter(p => p.compound).length
  timeMs.total = Math.round(performance.now() - t0)
  const manifest: WorldManifest = {
    format: WORLD_MANIFEST_FORMAT,
    version: WORLD_MANIFEST_VERSION,
    name,
    generator: live.generator,
    createdAt: new Date().toISOString(),
    space: live.space,
    regions,
    tiles,
    water: live.water,
    environment: live.environment,
    models,
    placements,
    ...(nav ? { nav } : {}),
    ...(spawn ? { spawn } : {}),
    ...(preset.displayName ? { displayName: preset.displayName } : {}),
    ...(playableRect ? { bounds: rectBounds(playableRect, origin) } : {}),
    ...(stream ? { stream } : {}),
    ...(places ? { places } : {}),
    ...(passed.coast ? { coast: passed.coast } : {}),
    ...(town ? { town } : {}),
    warnings: allWarnings,
    report: {
      regions: regions.length,
      regionsSkipped: live.report.regionsSkipped,
      placementRecords: live.report.placementRecords,
      placements: placements.length,
      dedupeConflicts: live.report.dedupeConflicts,
      uniqueObjectIds: live.report.uniqueObjectIds,
      compoundPlacements,
      uniqueModels: models.length,
      modelsConverted: models.filter(m => m.kind !== 'failed').length,
      failedModels: live.report.failedModels,
      lightmapTextures: live.report.lightmapTextures,
      tileTextures: tiles.length,
      validatorErrors: live.report.validatorErrors,
      sizes: { totalBytes: 0, byCategory: sizes },
      timeMs: {
        total: timeMs.total, terrain: timeMs.terrain ?? 0, navmesh: timeMs.navmesh ?? 0, objects: 0, textures: timeMs.textures ?? 0,
        nav: timeMs.nav ?? 0, stream: (timeMs.stream ?? 0) + (timeMs.after ?? 0),
      },
      ...(passed.coastReport ? { coast: passed.coastReport } : {}),
      ...(townReport ? { town: townReport } : {}),
      ...(passed.editsReport
        ? { edits: { ...(editsRun?.report?.() ?? {}), ...passed.editsReport, ...(footprintProblems !== undefined ? { footprintProblems } : {}) } }
        : {}),
      ...(passed.treesReport ? { trees: passed.treesReport } : {}),
      // DRAGON-INT: the remastered models are appended in the full convert's model loop (they are in the pre-pass cache)
      ...(live.report.remasterModels ? { remasterModels: live.report.remasterModels } : {}),
    },
  }
  const measure = () => {
    manifest.report.sizes.totalBytes = Object.values(sizes).reduce((s, n) => s + n, 0)
    return JSON.stringify(manifest, null, 1) + '\n'
  }
  sizes.manifest = Buffer.byteLength(measure())
  sizes.manifest = Buffer.byteLength(measure())
  staging.put('manifest.json', measure())

  // --- the coast snapshot (after a run), the record, the staging export's last links --------------------------------------
  if (coast && snapshotFile && snapKey) {
    const captured = c9Captured as { edits: PlacementEdits; warnings: string[] } | null
    const synthetic = [...syntheticIds]
    const changed = live.regions.filter(r => !r.synthetic && coast!.source.changed(r.x, r.z, loadRetail(r.x, r.z))).map(r => r.id)
    const report = { ...(coast.report?.() ?? {}) }
    const snapshot: CoastSnapshot = {
      format: COAST_SNAPSHOT_FORMAT, version: COAST_SNAPSHOT_VERSION, key: snapKey, name,
      synthetic, changed, dropRedrawn,
      nav: snapNav,
      c9: captured?.edits ?? { drop: [], resnap: [], add: [] },
      c9Warnings: captured?.warnings ?? [],
      manifestCoast: coast.manifestCoast?.() ?? null,
      report,
      createWarnings,
      typeNames: [...coast.typeNames()],
      places: coast.config.places.map(p => ({ name: p.name, x: p.x, z: p.z })),
      seaLevelM: coast.config.seaLevelM,
    }
    mkdirSync(dirname(snapshotFile), { recursive: true })
    writeFileSync(`${snapshotFile}.tmp`, encodeCoastSnapshot(snapshot))
    renameSync(`${snapshotFile}.tmp`, snapshotFile)
    log(`coast snapshot: ${Object.keys(snapNav).length} re-navigated region(s), ${changed.length} changed, ${synthetic.length} emitted -> ${snapshotFile}`)
  }
  if (recordFile) {
    mkdirSync(dirname(recordFile), { recursive: true })
    const coreAll = [...new Set([...carried, ...core])].sort((a, b) => a - b)
    writeFileSync(recordFile, JSON.stringify({ prePass: prePassHash, core: coreAll }) + '\n')
  }
  const { changed, removed } = staging.finish()
  lap('finish')
  timeMs.total = Math.round(performance.now() - t0)
  if (drift.length) log(`convert-region: DRIFT: ${drift.length} file(s) outside the work set differ from the live export (${drift.slice(0, 4).join(', ')}...): run a full convert`)
  log(`convert-region ${name}: ${changed.length} changed file(s), ${removed.length} removed, coast ${coastMode}, nav ${navChanged.size} edited region(s), ` +
    `${mb(changed.reduce((s, f) => s + staging.size(f), 0))} MiB in ${(timeMs.total / 1000).toFixed(1)} s -> ${stagingDir}`)
  return {
    manifest, stagingDir, changed, removed,
    regions: { core: [...core].sort((a, b) => a - b), ring: [...ring].sort((a, b) => a - b), nav: [...navChanged].sort((a, b) => a - b) },
    coast: coastMode, drift, timeMs,
  }
}

/** The client minimap tile of an active region for the world map, decoded (convertWorld's retailTile), or null. */
function worldMapRetailTile(media: ReturnType<typeof openArchive>, x: number, z: number, warnings: string[]): RgbaImage | null {
  const path = `minimap/${x}x${z}.ddj`
  if (!media.has(path)) return null
  try {
    return decodeDds(parseDdj(media.read(path)).dds)
  } catch (e) {
    warnings.push(`worldmap ${path}: ${(e as Error).message}`)
    return null
  }
}

/** The coast pass replayed from the snapshot: C9's edits and warnings, manifest.coast, report.coast with the new S1 check. */
function coastReplay(snap: CoastSnapshot, link: () => { reachable: boolean; opened: number } | null): CoastPass {
  return {
    placementEdits(ctx) {
      ctx.warnings.push(...snap.c9Warnings)
      return JSON.parse(JSON.stringify(snap.c9)) as PlacementEdits
    },
    manifestCoast: () => (snap.manifestCoast ? JSON.parse(JSON.stringify(snap.manifestCoast)) as WorldCoast : undefined),
    report: () => ({ ...(JSON.parse(JSON.stringify(snap.report)) as Record<string, unknown>), s1Link: link() }),
  }
}

/** The coast's places (./coast/hook.ts `places`) from the snapshot's config rows, on the new nav. */
function coastPlaces(snap: CoastSnapshot, world: NavWorld, origin: { x: number; z: number }, warnings: string[]): WorldPlace[] {
  const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d
  const out: WorldPlace[] = []
  for (const p of snap.places) {
    const fx = p.x * 1920
    const fz = p.z * 1920
    const pos = world.locate(fx, fz, Infinity)
    const y = pos ? pos.y / 10 : NaN
    if (!pos || !world.terrainOpen(fx, fz) || !(y > snap.seaLevelM)) {
      warnings.push(`coast: place ${p.name} (${p.x}, ${p.z}) is not on open ground above the sea level`)
      continue
    }
    out.push({
      name: p.name, x: round(192 * (p.x - origin.x)), y: round(y), z: round(-192 * (p.z - origin.z)),
      source: `content/coast/coast.json places (${p.x}, ${p.z}); on the coast's terrain, above the sea level`,
    })
  }
  return out
}

/**
 * The town dressing's node deps with the staging folder's links removed before each write (models, decals), and the
 * NPC list read beside the live export (the default reads ../../data/npcs.json relative to the export folder).
 */
function stagedDressingDeps(staging: Staging, liveDir: string): DressingDeps {
  const d = nodeDressingDeps()
  return {
    ...d,
    npcs: ctx => d.npcs({ ...ctx, outDir: liveDir }),
    async writeModel(req, ctx, base) {
      for (const stem of [req.stem, ...(req.from === 'retail' ? [outputStem(req.ref.trim().replace(/\//g, '\\'))] : [])]) {
        for (const ext of ['glb', 'json']) {
          staging.unlink(`models/${stem}.${ext}`)
          staging.written.add(`models/${stem}.${ext}`)
        }
      }
      return d.writeModel(req, ctx, base)
    },
    writeJson(ctx, rel, value) {
      staging.unlink(rel)
      staging.written.add(rel)
      d.writeJson(ctx, rel, value)
    },
  }
}

/**
 * The static-variant pass with the live export's variants reused: a skinned model whose variant the live export has
 * (same source, same glb) keeps it (its files are linked; the bake is a function of the skinned glb alone); any other is
 * baked by ../world/static-variants.ts after its paths are unlinked.
 */
function reusedStaticVariants(staging: Staging, liveModels: readonly WorldModel[]): StaticVariantPass {
  const bySource = new Map(liveModels.filter(m => m.source.endsWith(STATIC_SOURCE_SUFFIX)).map(m => [m.source, m]))
  return async ctx => {
    const out: Array<{ of: number; model: Omit<WorldModel, 'index' | 'staticVariant'> }> = []
    for (const model of variantCandidates(ctx.models, ctx.placements)) {
      const liveVariant = bySource.get(model.source + STATIC_SOURCE_SUFFIX)
      const glb = staticPath(model.glb!)
      if (liveVariant && liveVariant.glb === glb && existsSync(staging.path(glb)) && staging.liveBytes(glb) && !staging.written.has(model.glb!)) {
        const { index: _i, staticVariant: _s, treeSwap: _t, ...rest } = JSON.parse(JSON.stringify(liveVariant)) as WorldModel
        out.push({ of: model.index, model: rest })
        continue
      }
      for (const rel of [glb, staticPath(model.sidecar!)]) {
        staging.unlink(rel)
        staging.written.add(rel)
      }
      const v = await writeStaticVariant(model, ctx.outDir, ctx.warnings)
      if (v) out.push(v)
    }
    return out
  }
}

// --- CLI -------------------------------------------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const args = argv.slice()
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    if (i < 0) return undefined
    const v = args[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} expects a value`)
    args.splice(i, 2)
    return v
  }
  const has = (flag: string): boolean => {
    const i = args.indexOf(flag)
    if (i >= 0) args.splice(i, 1)
    return i >= 0
  }
  if (has('--help') || has('-h')) {
    console.log(USAGE)
    return 0
  }
  const world = take('--world') ?? 'jangan-fields'
  const live = take('--live')
  const stagingDir = take('--staging')
  const prepass = take('--prepass')
  const snapshot = take('--snapshot')
  const noSnapshot = has('--no-snapshot')
  const coastMode = take('--coast')
  const noRecord = has('--no-record')
  const json = take('--json')
  const lockWait = take('--lock-wait')
  const onlyAt = args.indexOf('--only')
  const only: string[] = []
  if (onlyAt >= 0) {
    args.splice(onlyAt, 1)
    while (args[onlyAt] !== undefined && !args[onlyAt]!.startsWith('--')) only.push(args.splice(onlyAt, 1)[0]!)
  }
  if (args.length) throw new Error(`convert-region: unexpected argument(s) ${args.join(' ')}\n${USAGE}`)
  if (coastMode !== undefined && coastMode !== 'run' && coastMode !== 'auto') throw new Error('--coast expects run or auto')
  const cfg = loadConfig()
  const waitMs = lockWait === undefined ? 30 * 60_000 : Number(lockWait) * 60_000
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('--lock-wait expects minutes')
  const result = await withConvertLock(convertLockPath(cfg.workDir), `convert-region --only ${world}`, () => convertRegions({
    world, only: parseOnly(only), liveDir: live && resolve(live), stagingDir: stagingDir && resolve(stagingDir), prePassCache: prepass && resolve(prepass),
    snapshot: noSnapshot ? null : snapshot && resolve(snapshot), coast: coastMode as 'run' | 'auto' | undefined, record: noRecord ? null : undefined,
    cfg, log: line => console.log(line),
  }), { waitMs, log: line => console.log(line) })
  for (const f of result.changed) console.log(`  changed ${f}`)
  for (const f of result.removed) console.log(`  removed ${f}`)
  if (json) {
    const { manifest: _m, ...rest } = result
    writeFileSync(resolve(json), JSON.stringify(rest, null, 1) + '\n')
  }
  return result.drift.length ? 2 : 0
}

const USAGE = `Usage: pnpm tsx packages/convert/src/tools/convert-region.ts --world <name> --only <x,z | x0-x1,z0-z1> [...]
  [--live <dir>] [--staging <dir>] [--prepass <file>] [--snapshot <file> | --no-snapshot] [--coast run|auto]
  [--no-record] [--json <file>] [--lock-wait <minutes>]
The incremental world convert (docs/WORLD_EDITOR.md §6.2 step 2): the regions the edit layers touch and their ring into
a staging export (default <live>-edit), under the convert lock; prints the changed files. Exit 2 when the live export
has drifted from the converter (run a full convert).`

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code
  }, (e: Error) => {
    console.error(e.message)
    process.exitCode = 1
  })
}
