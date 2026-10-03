/**
 * Navigation data and the spawn point of a converted world (docs/CONVENTIONS.md "Navigation", docs/NAVIGATION.md).
 *
 * - nav.bin: @sro/nav NavData of the converted regions (terrain .nvm + every object navmesh instance their object
 *   lists name, neighbour-owned big objects and .cpd compounds included), encoded with encodeNavData ('SRNV'). All
 *   the building is @sro/nav's buildNavData / createObjectNavMeshResolver; this file only feeds it and reports.
 * - spawn: the client's town return point (Media textdata teleportdata.txt, e.g. GATE_CH for Jangan), converted to
 *   glTF metres with space.ts and snapped onto the navigation surface with NavWorld.locate (the native spawn rule,
 *   NAVIGATION.md §6: nearest height to the stored GenPos_Y, terrain wins ties), then checked to be standable.
 *
 * Node-free: the caller passes parsed .nvm files and file readers.
 */
import { parseObjectIfo, parseTextdata, type NvmFile } from '@sro/formats'
import {
  buildNavData, createObjectNavMeshResolver, encodeNavData, NAV_DATA_VERSION, NavWorld,
  type NavData, type NavPosition,
} from '@sro/nav'
import { toGltfPosition, UNIT_SCALE } from '../gltf/space.ts'
import type { WorldNav, WorldSpawn } from './manifest.ts'

export const NAV_FILE = 'nav.bin'
export const TELEPORTDATA_PATH = 'server_dep/silkroad/textdata/teleportdata.txt'
/** Where the .nvm object ids point (the object.ifo of Data.pk2's navmesh folder). */
export const NAV_OBJECT_IFO = 'navmesh/object.ifo'
const REGION_UNITS = 1920

type Read = (pk2Path: string) => Uint8Array | undefined

export interface WorldNavBuild {
  data: NavData
  bytes: Uint8Array
  info: Omit<WorldNav, 'file' | 'bytes'>
}

/**
 * NavData of `regions` (parsed .nvm, id = z << 8 | x). `readData` reads Data.pk2 paths (object.ifo, .bsr, .cpd,
 * .bms). Instances overhanging from regions outside the set are included (they are in the .nvm object lists).
 */
export function buildWorldNav(regions: ReadonlyArray<{ id: number; nvm: NvmFile }>, readData: Read, warnings: string[]): WorldNavBuild {
  const ifoBytes = readData(NAV_OBJECT_IFO)
  if (!ifoBytes) throw new Error(`${NAV_OBJECT_IFO}: missing`)
  const ifo = parseObjectIfo(ifoBytes)
  const navWarnings: string[] = []
  const data = buildNavData({ regions, objectNavMesh: createObjectNavMeshResolver(ifo, readData, navWarnings) }, navWarnings)
  for (const w of navWarnings) warnings.push(`nav: ${w}`)
  const bytes = encodeNavData(data)
  const ids = new Set(data.regions.map(r => r.id))
  const isCpd = (objId: number) => ifo.byIndex.get(objId)?.path.toLowerCase().endsWith('.cpd') ?? false
  return {
    data,
    bytes,
    info: {
      format: 'SRNV',
      version: NAV_DATA_VERSION,
      space: 'file',
      regions: data.regions.map(r => r.id),
      models: data.models.length,
      instances: data.instances.length,
      neighbourInstances: data.instances.filter(i => !ids.has(i.id >>> 16)).length,
      compoundInstances: data.instances.filter(i => isCpd(i.objId)).length,
      links: data.instances.reduce((n, i) => n + i.links.length, 0),
    },
  }
}

/** Streaming split of a world's NavData (docs/FIELDS.md §3.9): the folder and file names are the manifest's. */
export const NAV_REGION_DIR = 'nav'
export const NAV_OBJECTS_FILE = 'nav-objects.bin'

/** Relative path of one region's nav chunk. */
export const navRegionFile = (id: number) => `${NAV_REGION_DIR}/${id & 0xff}_${(id >> 8) & 0xff}.bin`

/**
 * nav.bin split for streaming: one SRNV per terrain region (exactly that NavRegion; no models or instances) and one
 * SRNV with no regions holding every model, instance and link in nav.bin's order. A client that decodes the objects
 * once and adds regions as they stream in gets the same NavData as nav.bin restricted to those regions.
 */
export function splitWorldNav(data: NavData): { regions: Array<{ id: number; file: string; bytes: Uint8Array }>; objects: Uint8Array } {
  return {
    regions: data.regions.map(r => ({
      id: r.id,
      file: navRegionFile(r.id),
      bytes: encodeNavData({ version: data.version, regions: [r], models: [], instances: [] }),
    })),
    objects: encodeNavData({ version: data.version, regions: [], models: data.models, instances: data.instances }),
  }
}

/** One teleportdata.txt row (the _RefTeleport columns the spawn needs). */
export interface TeleportPoint {
  /** Column 1. */
  id: number
  /** CodeName128, column 2 (GATE_CH = Jangan). */
  code: string
  /** ZoneName128, column 4 (SN_ZONE_22001 = Jangan). */
  zone: string
  /** GenRegionID, column 5: z << 8 | x. */
  regionId: number
  /** GenPos_X/Y/Z, columns 6-8: region-local file units (Y is a coarse height hint: 0 for GATE_CH). */
  x: number
  y: number
  z: number
  /** GenAreaRadius, column 9 (file units). */
  radius: number
  /** CanBeResurrectPos, column 10: a return/resurrect point. */
  resurrect: boolean
  /** 1-based line in the file. */
  line: number
}

/** Service = 1 rows of teleportdata.txt (UTF-16LE textdata). */
export function parseTeleportData(bytes: Uint8Array): TeleportPoint[] {
  const out: TeleportPoint[] = []
  for (const row of parseTextdata(bytes, 'teleportdata.txt').rows) {
    const c = row.cells
    if (c.length < 11 || c[0]!.trim() !== '1') continue
    const n = (i: number) => Number(c[i]!.trim())
    out.push({
      id: n(1), code: c[2]!.trim(), zone: c[4]!.trim(), regionId: n(5), x: n(6), y: n(7), z: n(8), radius: n(9),
      resurrect: n(10) === 1, line: row.line,
    })
  }
  return out
}

/**
 * The teleport point to spawn at: `code` when given, else the first return (resurrect) point inside `regionIds`.
 * null when none qualifies.
 */
export function pickSpawnTeleport(points: TeleportPoint[], regionIds: ReadonlySet<number>, code?: string): TeleportPoint | null {
  if (code) return points.find(p => p.code === code && regionIds.has(p.regionId)) ?? null
  return points.find(p => p.resurrect && p.regionId > 0 && regionIds.has(p.regionId)) ?? null
}

/**
 * Why `p` is not a place to put a new character, or null when it is: it must be on an open terrain tile or on an
 * object navmesh that can be walked off (not a sealed footprint: some outline edge flag 0 or a link), have no
 * other navmesh floor 0.1..2 m above it (inside a building part), and let the character walk 2 m in at least
 * half of 8 directions.
 */
export function spawnProblem(world: NavWorld, p: NavPosition): string | null {
  if (!Number.isFinite(p.y)) return 'no height'
  if (p.surface.kind === 'terrain') {
    if (!world.terrainOpen(p.x, p.z)) return 'closed terrain tile'
  } else {
    const inst = world.data.instances[p.surface.instance]!
    const model = world.data.models[inst.model]!
    if (!model.outline.flags.some(f => f === 0) && inst.links.length === 0) return `sealed object navmesh ${model.key}`
  }
  if (!world.canStand(p.x, p.z, p.y, 1)) return 'canStand() is false'
  for (let dy = 1; dy <= 20; dy++) {
    const q = world.locate(p.x, p.z, p.y + dy)
    if (q && q.y > p.y + 1 && q.y <= p.y + 20) return `navmesh floor ${((q.y - p.y) * UNIT_SCALE).toFixed(2)} m above`
  }
  let free = 0
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * 2 * Math.PI
    const r = world.moveStraight(p, p.x + 20 * Math.cos(a), p.z + 20 * Math.sin(a))
    if (!r.blocked) free++
  }
  if (free < 4) return `boxed in (${free}/8 directions free)`
  return null
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0

/**
 * Spawn from a teleport point: file position -> glTF metres (space.ts, relative to the origin region), y from
 * NavWorld.locate with the row's GenPos_Y as the height hint. Returns the spawn and the located nav position, or
 * the reason it was rejected.
 */
export function spawnFromTeleport(world: NavWorld, t: TeleportPoint, origin: { x: number; z: number }):
  { spawn: WorldSpawn; pos: NavPosition } | { error: string } {
  const rx = t.regionId & 0xff
  const rz = (t.regionId >> 8) & 0xff
  const fx = REGION_UNITS * rx + t.x
  const fz = REGION_UNITS * rz + t.z
  const pos = world.locate(fx, fz, t.y)
  if (!pos) return { error: `${t.code}: no navigation surface at region ${rx},${rz} (${t.x}, ${t.z})` }
  const problem = spawnProblem(world, pos)
  if (problem) return { error: `${t.code}: ${problem}` }
  const g = toGltfPosition([REGION_UNITS * (rx - origin.x) + t.x, pos.y, REGION_UNITS * (rz - origin.z) + t.z])
  const surface = pos.surface.kind === 'terrain'
    ? 'terrain'
    : `${world.data.models[world.data.instances[pos.surface.instance]!.model]!.key.split('/').pop()} cell ${pos.surface.cell}`
  return {
    pos,
    spawn: {
      x: round4(g[0]),
      y: round4(g[1]),
      z: round4(g[2]),
      // Facing is not in the client data. 0 = @sro/shared yawTowards convention (atan2(dx, dz)): facing glTF +Z,
      // i.e. south (file -Z); at Jangan's GATE_CH that is toward the fountain 51 m away.
      yaw: 0,
      source: `Media ${TELEPORTDATA_PATH} line ${t.line}: ${t.code} (${t.zone}, id ${t.id}${t.resurrect ? ', CanBeResurrectPos' : ''}) ` +
        `GenRegionID ${t.regionId} (${rx},${rz}) GenPos (${t.x}, ${t.y}, ${t.z}) radius ${t.radius}; ` +
        `y = @sro/nav locate(hint GenPos_Y) on ${surface}; yaw 0 (not in client data: facing south)`,
    },
  }
}
