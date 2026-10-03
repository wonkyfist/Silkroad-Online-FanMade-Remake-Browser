import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CODE_NAME, PLAYER_MODELS_CH } from '@sro/shared'

/**
 * Content the server reads from the converter output (OUT_DIR). Everything is optional: the
 * server starts with built-in fallbacks when the files are missing or in an unexpected shape.
 */

/** Silkroad region edge: 1920 file units = 192 m. */
export const REGION_SIZE_M = 192

export const FALLBACK_CHARACTER_MODELS = ['CHAR_CH_MAN_ADVENTURER', 'CHAR_CH_WOMAN_ADVENTURER']

export interface Bounds {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

export interface WorldSetup {
  spawn: { x: number; y: number; z: number }
  /**
   * Height hint (metres) for placing the spawn on the navmesh (docs/NAVIGATION.md §5.2): the manifest spawn's y
   * (the exporter located it on the right surface, e.g. the Jangan plaza), else +Infinity (the highest open surface).
   * Never a bare terrain height: at the Jangan gate that is the hidden terrain under the plaza.
   */
  spawnHintY?: number
  /** How the spawn was chosen (logged at startup). */
  spawnSource: string
  bounds: Bounds | null
  /** Human-readable location for the character list. */
  displayName: string
  /**
   * Region grid coordinates of the region whose south-west corner is the world origin (manifest
   * `origin`, or `space.originRegion`), or null. Used to name the region a position is in.
   */
  regionOrigin: { ox: number; oz: number } | null
  /**
   * Named teleport targets for GM `tp <name>`: the world name (e.g. `jangan`) and `spawn` map to the
   * spawn point; the manifest may add more (see manifestPlaces), then CONTENT_DIR/places.json (withAuthoredPlaces).
   * The server start keeps only the ones that place on the navmesh (places.ts checkPlaces).
   */
  places: Place[]
}

/** The GM teleport list's groups, in the order the GM window shows them. */
export const PLACE_GROUPS = ['town', 'fields', 'coast', 'bosses', 'other'] as const
export type PlaceGroup = (typeof PLACE_GROUPS)[number]

/** One GM teleport place (glTF metres). */
export interface Place {
  name: string
  x: number
  z: number
  /** Height hint: `tp` stands on the open surface nearest it (none: the highest open surface). */
  y?: number
  group: PlaceGroup
  /** Other names `tp` accepts for it (e.g. beach-south for jangan-south-beach). */
  aliases?: string[]
}

/** The authored teleport places (CONTENT_DIR), merged after the manifest's (docs/PLAYTEST.md "Teleport places"). */
export const PLACES_FILE = 'places.json'

/** Region grid coordinates and id (z << 8 | x) of a world position, given the origin region. */
export function regionAt(origin: { ox: number; oz: number } | null, x: number, z: number): { rx: number; rz: number; id: number } | null {
  if (!origin) return null
  const rx = origin.ox + Math.floor(x / REGION_SIZE_M)
  const rz = origin.oz + Math.floor(-z / REGION_SIZE_M)
  if (rx < 0 || rx > 255 || rz < 0 || rz > 255) return null
  return { rx, rz, id: (rz << 8) | rx }
}

/** Place names: lower-case letters, digits, _ and - (spaces become _), at most 32 characters. */
export function placeName(raw: string): string | null {
  const n = raw.trim().toLowerCase().replace(/\s+/g, '_')
  return /^[a-z0-9_-]{1,32}$/.test(n) ? n : null
}

/**
 * Optional named places in the world manifest: `places`, `teleports`, `landmarks` or `locations`,
 * each either an array of { name | id | label, pos | position | x/z } or an object mapping
 * name -> point ([x, y, z], [x, z] or {x, z}).
 */
export function manifestPlaces(manifest: Record<string, unknown>): Place[] {
  const out: Place[] = []
  for (const key of ['places', 'teleports', 'landmarks', 'locations']) {
    const v = manifest[key]
    const rows: [unknown, unknown][] = Array.isArray(v)
      ? v.map((e) => [isObj(e) ? (e.name ?? e.id ?? e.label) : undefined, e])
      : isObj(v)
        ? Object.entries(v)
        : []
    for (const [rawName, rawPoint] of rows) {
      if (typeof rawName !== 'string') continue
      const name = placeName(rawName)
      const p = point(rawPoint)
      if (!name || !p || out.some((o) => o.name === name)) continue
      out.push({ name, x: p.x, z: p.z, ...(hasHeight(rawPoint) ? { y: p.y } : {}), group: manifestGroup(rawPoint) })
    }
  }
  return out
}

/**
 * A manifest place's group: its own `group` when it names one, `coast` when its source is the coast design
 * (beach-south), else `fields` (the client's textzonename.txt areas).
 */
function manifestGroup(v: unknown): PlaceGroup {
  if (!isObj(v)) return 'fields'
  if (isGroup(v.group)) return v.group
  return typeof v.source === 'string' && /coast/i.test(v.source) ? 'coast' : 'fields'
}

function isGroup(v: unknown): v is PlaceGroup {
  return typeof v === 'string' && (PLACE_GROUPS as readonly string[]).includes(v)
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Reads CONTENT_DIR/places.json (`{ schema: 1, kind: 'places', world, places: [{ name, group, x, y?, z, aliases? }] }`)
 * leniently: a bad row is reported and skipped, no file is no places, a file for another world is ignored.
 */
export function readAuthoredPlaces(contentDir: string | undefined, world: string): { places: Place[]; problems: string[]; file: string | null } {
  if (!contentDir) return { places: [], problems: [], file: null }
  const file = join(contentDir, PLACES_FILE)
  if (!existsSync(file)) return { places: [], problems: [], file: null }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { places: [], problems: [`${PLACES_FILE}: ${(e as Error).message}`], file }
  }
  if (!isObj(raw) || !Array.isArray(raw.places)) return { places: [], problems: [`${PLACES_FILE}: expected { places: [...] }`], file }
  if (typeof raw.world === 'string' && raw.world.toLowerCase() !== world.toLowerCase()) return { places: [], problems: [], file: null }
  return { ...parsePlaceRows(raw.places), file }
}

/** The rows of places.json (see readAuthoredPlaces). Names are kebab-case, at most 32 characters, each listed once. */
export function parsePlaceRows(rows: unknown[]): { places: Place[]; problems: string[] } {
  const places: Place[] = []
  const problems: string[] = []
  const taken = new Set<string>()
  rows.forEach((row, i) => {
    const where = `${PLACES_FILE} places[${i}]`
    if (!isObj(row)) return problems.push(`${where}: expected an object`)
    const name = typeof row.name === 'string' && KEBAB.test(row.name) ? placeName(row.name) : null
    if (!name) return problems.push(`${where}: the name must be kebab-case (a-z, 0-9, -), at most 32 characters`)
    if (!finite(row.x) || !finite(row.z) || (row.y !== undefined && !finite(row.y))) return problems.push(`${where} (${name}): x, z (and y) must be finite numbers`)
    if (row.group !== undefined && !isGroup(row.group)) return problems.push(`${where} (${name}): the group must be one of ${PLACE_GROUPS.join(', ')}`)
    const rawAliases: unknown[] = Array.isArray(row.aliases) ? row.aliases : []
    const aliases = rawAliases.filter((a): a is string => typeof a === 'string' && KEBAB.test(a) && placeName(a) === a)
    if (aliases.length !== rawAliases.length) problems.push(`${where} (${name}): aliases that are not kebab-case names ignored`)
    const dup = [name, ...aliases].find((n, k, all) => taken.has(n) || all.indexOf(n) !== k)
    if (dup) return problems.push(`${where}: ${dup} is listed twice`)
    for (const n of [name, ...aliases]) taken.add(n)
    places.push({ name, x: row.x, z: row.z, ...(finite(row.y) ? { y: row.y } : {}), group: isGroup(row.group) ? row.group : 'other', ...(aliases.length ? { aliases } : {}) })
  })
  return { places, problems }
}

/**
 * The manifest's places, then the authored ones: an authored place replaces a manifest place of the same name (the
 * western-china-ferry fix) and takes over the names of its aliases (beach-south). The world name and `spawn` stay
 * the town spawn's.
 */
export function mergePlaces(base: Place[], authored: Place[], world: string): { places: Place[]; problems: string[] } {
  const reserved = new Set([world.toLowerCase(), 'spawn'])
  const problems: string[] = []
  const keep = authored.filter((p) => {
    const clash = [p.name, ...(p.aliases ?? [])].find((n) => reserved.has(n))
    if (clash) problems.push(`${PLACES_FILE}: ${p.name}: ${clash} is the town spawn's name`)
    return !clash
  })
  const own = new Map(keep.map((p) => [p.name, p]))
  const aliased = new Set(keep.flatMap((p) => p.aliases ?? []))
  const out: Place[] = []
  for (const p of base) {
    const mine = own.get(p.name)
    if (mine) {
      out.push(mine)
      own.delete(p.name)
    } else if (!aliased.has(p.name)) out.push(p)
  }
  return { places: [...out, ...own.values()], problems }
}

/** `setup` with CONTENT_DIR/places.json merged in (problems logged). */
export function withAuthoredPlaces(setup: WorldSetup, contentDir: string | undefined, world: string, log: (msg: string) => void): WorldSetup {
  const read = readAuthoredPlaces(contentDir, world)
  const merged = mergePlaces(setup.places, read.places, world)
  for (const p of [...read.problems, ...merged.problems]) log(`places: ${p}`)
  return read.file ? { ...setup, places: merged.places } : setup
}

type Json = Record<string, unknown>

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Accepts [x, y, z], [x, z] or {x, y?, z}. */
function point(v: unknown): { x: number; y: number; z: number } | null {
  if (Array.isArray(v)) {
    if (v.length === 3 && v.every(finite)) return { x: v[0], y: v[1], z: v[2] }
    if (v.length === 2 && v.every(finite)) return { x: v[0], y: 0, z: v[1] }
    return null
  }
  if (isObj(v)) {
    if (finite(v.x) && finite(v.z)) return { x: v.x, y: finite(v.y) ? v.y : 0, z: v.z }
    if (v.pos !== undefined) return point(v.pos)
    if (v.position !== undefined) return point(v.position)
  }
  return null
}

/** Whether a point() input carries a height ([x, y, z] or {y}), not the 0 filled in for [x, z] / {x, z}. */
function hasHeight(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 3
  if (!isObj(v)) return false
  if (finite(v.x) && finite(v.z)) return finite(v.y)
  return hasHeight(v.pos ?? v.position)
}

/** Accepts {min, max} (points) or {minX, minZ, maxX, maxZ}. */
function bounds(v: unknown): Bounds | null {
  if (!isObj(v)) return null
  if (finite(v.minX) && finite(v.minZ) && finite(v.maxX) && finite(v.maxZ)) {
    return { minX: v.minX, minZ: v.minZ, maxX: v.maxX, maxZ: v.maxZ }
  }
  const a = point(v.min)
  const b = point(v.max)
  if (a && b) return { minX: Math.min(a.x, b.x), minZ: Math.min(a.z, b.z), maxX: Math.max(a.x, b.x), maxZ: Math.max(a.z, b.z) }
  return null
}

function union(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null
  return list.reduce((u, b) => ({
    minX: Math.min(u.minX, b.minX),
    minZ: Math.min(u.minZ, b.minZ),
    maxX: Math.max(u.maxX, b.maxX),
    maxZ: Math.max(u.maxZ, b.maxZ),
  }))
}

function centre(b: Bounds): { x: number; z: number } {
  return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 }
}

interface RegionInfo {
  rx: number
  rz: number
  bounds: Bounds | null
}

/** Region grid coordinates from {x, z} / {rx, rz} / {id} (id = z << 8 | x) or a "xZ" style key. */
function regionInfo(v: unknown): RegionInfo | null {
  if (!isObj(v)) return null
  let rx: number | undefined
  let rz: number | undefined
  if (finite(v.rx) && finite(v.rz)) [rx, rz] = [v.rx, v.rz]
  else if (finite(v.x) && finite(v.z) && Number.isInteger(v.x) && Number.isInteger(v.z) && v.x < 256 && v.z < 256) {
    ;[rx, rz] = [v.x, v.z]
  } else if (finite(v.id)) [rx, rz] = [v.id & 0xff, (v.id >> 8) & 0xff]
  else if (Array.isArray(v.region) && v.region.length === 2 && v.region.every(finite)) [rx, rz] = [v.region[0], v.region[1]]
  if (rx === undefined || rz === undefined) return null
  let b = bounds(v.bounds) ?? bounds(v)
  if (!b) {
    const off = point(v.offset) ?? point(v.origin) ?? point(v.worldOffset)
    if (off) b = { minX: off.x, minZ: off.z, maxX: off.x + REGION_SIZE_M, maxZ: off.z + REGION_SIZE_M }
  }
  return { rx, rz, bounds: b }
}

/**
 * Where new characters appear, in order of preference:
 * 1. SPAWN_X/SPAWN_Z (override passed in by the caller);
 * 2. the manifest's `spawn` (point: [x,y,z], [x,z] or {x,y,z});
 * 3. the centre of the centre region: the listed region whose grid coords are nearest the median
 *    of all listed regions. Its world rectangle is its own `bounds`/`min`/`max`, or `offset` (its min x/z corner)
 *    + 192 m; failing that, the manifest's origin rule is applied: region (rx, rz) spans
 *    x = (rx - ox) * 192 .. +192 and z = -(rz - oz) * 192 .. -192 (Z is mirrored into glTF space),
 *    where `origin` = [ox, oz] region coords (or {x, z} / {rx, rz});
 * 4. the centre of the manifest's `bounds`;
 * 5. (0, 0).
 *
 * `folder` is the export folder under OUT_DIR/world/ (WORLD_EXPORT, e.g. 'jangan-fields'); `id` is the world id
 * (WORLD, e.g. 'jangan', default: the folder). The id names the first GM place (`tp jangan`) and the default
 * display name, so a bigger export keeps the world's own name (docs/FIELDS.md §4.1).
 */
export function resolveWorld(outDir: string, folder: string, override: { x: number; z: number } | null, id = folder): WorldSetup {
  const world = id
  const displayName = world.charAt(0).toUpperCase() + world.slice(1)
  let manifest: Json | null = null
  const file = join(outDir, 'world', folder, 'manifest.json')
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isObj(parsed)) manifest = parsed
  } catch {
    manifest = null
  }

  const regions = manifest && Array.isArray(manifest.regions) ? manifest.regions.map(regionInfo).filter((r) => r !== null) : []
  const origin = manifest ? regionOrigin(manifest.origin) : null
  if (origin) {
    for (const r of regions) {
      if (!r.bounds) {
        const x0 = (r.rx - origin.ox) * REGION_SIZE_M
        const z0 = -(r.rz - origin.oz) * REGION_SIZE_M
        r.bounds = { minX: x0, maxX: x0 + REGION_SIZE_M, minZ: z0 - REGION_SIZE_M, maxZ: z0 }
      }
    }
  }
  const worldBounds = (manifest && bounds(manifest.bounds)) ?? union(regions.flatMap((r) => (r.bounds ? [r.bounds] : [])))
  const name = manifest && typeof manifest.displayName === 'string' ? manifest.displayName.slice(0, 64) : displayName

  const space = manifest && isObj(manifest.space) ? manifest.space : null
  const originRegion = (manifest ? regionOrigin(manifest.origin) : null) ?? (space ? regionOrigin(space.originRegion) : null)
  const extraPlaces = manifest ? manifestPlaces(manifest) : []
  const manifestSpawn = manifest ? point(manifest.spawn) : null
  const manifestSpawnY = manifestSpawn && manifest && hasHeight(manifest.spawn) ? manifestSpawn.y : undefined
  const setup = (x: number, y: number, z: number, spawnSource: string): WorldSetup => {
    const places: Place[] = [
      { name: world.toLowerCase(), x, z, group: 'town' },
      { name: 'spawn', x, z, group: 'town' },
    ]
    for (const p of extraPlaces) if (!places.some((q) => q.name === p.name)) places.push(p)
    const nearManifest = manifestSpawn && manifestSpawnY !== undefined && Math.hypot(manifestSpawn.x - x, manifestSpawn.z - z) < 2
    return {
      spawn: { x, y, z },
      spawnHintY: nearManifest ? manifestSpawnY : Infinity,
      spawnSource,
      bounds: worldBounds,
      displayName: name,
      regionOrigin: originRegion,
      places,
    }
  }

  if (override) return setup(override.x, 0, override.z, 'SPAWN_X/SPAWN_Z')
  if (!manifest) return setup(0, 0, 0, `default (no ${file})`)
  if (manifestSpawn) return setup(manifestSpawn.x, manifestSpawn.y, manifestSpawn.z, 'manifest spawn')
  const withBounds = regions.filter((r) => r.bounds)
  if (withBounds.length > 0) {
    const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]
    const mx = med(withBounds.map((r) => r.rx))
    const mz = med(withBounds.map((r) => r.rz))
    const best = withBounds.reduce((a, b) => (Math.hypot(b.rx - mx, b.rz - mz) < Math.hypot(a.rx - mx, a.rz - mz) ? b : a))
    const c = centre(best.bounds!)
    return setup(c.x, 0, c.z, `centre of region ${best.rx},${best.rz}`)
  }
  if (worldBounds) {
    const c = centre(worldBounds)
    return setup(c.x, 0, c.z, 'centre of manifest bounds')
  }
  return setup(0, 0, 0, 'default (manifest has no spawn hint)')
}

/**
 * Rule 2b of the spawn order (between the manifest's own `spawn` and the region-centre fallback): the return
 * point of this world's town from OUT_DIR/data/towns.json (client teleportdata), so new characters, respawns and
 * `tp <world>` land at the town gate. SPAWN_X/SPAWN_Z and an explicit manifest spawn still win.
 */
export function withTownSpawn(setup: WorldSetup, world: string, town: { name: string; spawn: { x: number; y: number; z: number } } | undefined): WorldSetup {
  if (!town || setup.spawnSource === 'SPAWN_X/SPAWN_Z' || setup.spawnSource === 'manifest spawn') return setup
  const { x, y, z } = town.spawn
  const places: Place[] = [
    { name: world.toLowerCase(), x, z, group: 'town' },
    { name: 'spawn', x, z, group: 'town' },
    ...setup.places.filter((p) => p.name !== world.toLowerCase() && p.name !== 'spawn'),
  ]
  // towns.json heights are terrain heights (a hazard under decks): place with the highest open surface instead.
  return { ...setup, spawn: { x, y, z }, spawnHintY: Infinity, spawnSource: `town ${town.name} (towns.json)`, places }
}

function regionOrigin(v: unknown): { ox: number; oz: number } | null {
  if (Array.isArray(v) && v.length >= 2 && finite(v[0]) && finite(v[v.length - 1])) return { ox: v[0], oz: v[v.length - 1] }
  if (isObj(v)) {
    if (finite(v.rx) && finite(v.rz)) return { ox: v.rx, oz: v.rz }
    if (finite(v.x) && finite(v.z)) return { ox: v.x, oz: v.z }
    if (v.region !== undefined) return regionOrigin(v.region)
  }
  return null
}

/**
 * Character models allowed at creation. Mirrors the game client's catalog rule
 * (apps/game/src/content/catalog.ts) so the server accepts exactly what the client offers:
 * - OUT_DIR/data/characters.json (packages/convert/src/tools/export-data.ts) is authoritative when it
 *   lists at least one selectable model: code from codeName128 | codeName | code | id | object key;
 *   allowed when `selectable`/`playable`/`creatable` is true, or when no flag is given and the code
 *   is one of PLAYER_MODELS_CH. Shapes: an array, `{ characters | models | items: [...] }`, or an
 *   object keyed by CodeName128.
 * - Only without it: OUT_DIR/index.json (converter index): char/china/china(wo)man_<x> ->
 *   CHAR_CH_(WO)MAN_<X> when listed in PLAYER_MODELS_CH, plus CHAR_CH_MAN_ADVENTURER and
 *   CHAR_CH_WOMAN_ADVENTURER.
 * European models (CHAR_EU_*) are never allowed (content scope is Chinese only). Both files are
 * re-read when their mtime changes, so a running server picks up a new export.
 */
export class CharacterModels {
  private cache = new Map<string, { mtimeMs: number; models: string[] }>()

  constructor(private readonly outDir: string) {}

  /** Where the current list came from (logged at startup). */
  source = ''

  list(): string[] {
    const exported = this.read(join(this.outDir, 'data', 'characters.json'), extractModels)
    if (exported.length > 0) {
      this.source = 'data/characters.json'
      return exported
    }
    this.source = 'index.json + fallback (no data/characters.json)'
    return [...new Set([...FALLBACK_CHARACTER_MODELS, ...this.read(join(this.outDir, 'index.json'), modelsFromIndex)])]
  }

  allowed(model: string): boolean {
    return this.list().includes(model)
  }

  private read(file: string, extract: (v: unknown) => string[]): string[] {
    let mtimeMs: number
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      this.cache.delete(file)
      return []
    }
    const hit = this.cache.get(file)
    if (hit && hit.mtimeMs === mtimeMs) return hit.models
    let models: string[] = []
    try {
      models = extract(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      models = []
    }
    this.cache.set(file, { mtimeMs, models })
    return models
  }
}

function selectableCode(code: unknown, flag: unknown): code is string {
  if (typeof code !== 'string' || !CODE_NAME.test(code) || !code.startsWith('CHAR_') || code.startsWith('CHAR_EU_')) return false
  return typeof flag === 'boolean' ? flag : PLAYER_MODELS_CH.includes(code)
}

/** Selectable models listed in a characters.json export. */
export function extractModels(data: unknown): string[] {
  let rows: [string | undefined, unknown][] = []
  if (Array.isArray(data)) rows = data.map((e) => [undefined, e])
  else if (isObj(data)) {
    const list = data.characters ?? data.models ?? data.items
    if (Array.isArray(list)) rows = list.map((e) => [undefined, e])
    else if (isObj(list)) rows = Object.entries(list)
    else rows = Object.entries(data).filter(([k]) => k.startsWith('CHAR_'))
  }
  const out: string[] = []
  for (const [key, raw] of rows) {
    if (typeof raw === 'string') {
      if (selectableCode(raw, undefined)) out.push(raw)
      continue
    }
    if (!isObj(raw)) continue
    const code = raw.codeName128 ?? raw.codeName ?? raw.code ?? raw.id ?? key
    if (selectableCode(code, raw.selectable ?? raw.playable ?? raw.creatable)) out.push(code)
  }
  return out
}

/** Chinese player models present in the converter index (char/china/chinaman_x -> CHAR_CH_MAN_X). */
export function modelsFromIndex(index: unknown): string[] {
  if (!Array.isArray(index)) return []
  const out: string[] = []
  for (const row of index) {
    if (!isObj(row) || typeof row.id !== 'string') continue
    const m = /^char\/china\/china(woman|man)_([a-z0-9_]+)$/i.exec(row.id)
    if (!m) continue
    const code = `CHAR_CH_${m[1].toUpperCase()}_${m[2].toUpperCase()}`
    if (PLAYER_MODELS_CH.includes(code)) out.push(code)
  }
  return out
}
