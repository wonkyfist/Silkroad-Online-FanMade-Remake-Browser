/**
 * Read-only access to the third-party port's server data (JSON files only; its code is never used or run).
 * These files carry server-only vSRO tables the client lacks: Tab_RefNest/Hive/Tactics (spawns.json), drop chains
 * (drops.json) and NPC shop placements. Every record derived from them is tagged PROVENANCE_PORT. Only the fields
 * below are read; everything else in the files is ignored.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** spawns.json: { [zone]: PortNest[] }. Positions/radii are in the port frame (data/frame.ts, derived). */
export interface PortNest {
  nestId: number
  mobId: string
  vsroCode: string
  x: number
  z: number
  y?: number
  level?: number
  count: number
  radius: number
  spawnRadius: number
  championPct?: number
  respawn?: number
  tacticsId: number
  sightRangeU: number
  aggressTypeRaw: number
  traceBoundaryU: number
  staminaRaw?: number
  staminaVarPct?: number
  respawnDelaySec: [number, number]
}

export interface PortPlacement {
  zone: string
  x: number
  z: number
  y?: number
  rotY?: number
}

/** npcshops.json shops.<id>: an NPC (sroCode = characterdata CodeName128) with its placements and stock. */
export interface PortShopNpc {
  id: string
  sroCode?: string
  placements?: PortPlacement[]
  shop?: { tabs?: Array<{ name: string; items: string[] }> }
}

/**
 * npcshops.json zones.<zone>.npcs[]: every NPC the port places in a zone, with its facing (rotY, port convention: a
 * model facing port +z turned by rotY about +y, i.e. facing (sin rotY, cos rotY) in (east, north); data/frame.ts
 * portYawToWorld). `npcId` names a shops.<id> entry (its sroCode is the client code) or lower-cases the client code.
 */
export interface PortZoneNpc {
  npcId: string
  x: number
  z: number
  y?: number
  rotY?: number
}

/** teleporters.json zones.<zone>[]: teleport NPCs and gates; `id` lower-cases the client teleportdata code. */
export interface PortTeleporter {
  id: string
  x: number
  z: number
  y?: number
  rotY?: number
}

/** mobs.json mobs[]: only `variants` is used (champion/giant opt-in). */
export interface PortMob {
  id: string
  variants?: { champion?: boolean; giant?: boolean }
}

export interface PortDropTable {
  mobId: string
  vsroCode: string
  level?: number
  gold?: { chance: number; min: number; max: number }
  items: Array<{ itemId: string; qty: number; chance: number }>
}

/** drops.json: `$oranlar` holds the rates the port multiplied into the values (goldRate x gold amounts). */
export interface PortDrops {
  rates: { goldRate: number; itemDropRate: number; rareDropRate: number }
  tables: PortDropTable[]
}

/** itemmap-tam.json: port item id -> client CodeName128 (codeW = the female twin of gendered armour). */
export type PortItemMap = Record<string, { code: string; codeW?: string }>

export interface PortUnique {
  monsterId: string
  zoneId: string
  respawnMinutes?: [number, number]
  camps: Array<{ nestId: number; x: number; z: number }>
}

/** safe-areas.json zones.<zone>[]: axis-aligned town boxes (centre + half extents, port frame). */
export interface PortSafeArea {
  x: number
  z: number
  rotY?: number
  shape: { kind: string; hx: number; hz: number; ox?: number; oz?: number }
}

export interface PortData {
  dir: string
  safeAreas: Record<string, PortSafeArea[]>
  spawns: Record<string, PortNest[]>
  shops: PortShopNpc[]
  /** npcshops.json zones.<zone>.npcs (optional so hand-built PortData in tests keeps working). */
  zoneNpcs?: Record<string, PortZoneNpc[]>
  teleporters: Record<string, PortTeleporter[]>
  mobs: PortMob[]
  drops: PortDrops
  itemMap: PortItemMap
  uniques: PortUnique[]
}

export const PORT_FILES = {
  spawns: 'spawns.json',
  shops: 'npcshops.json',
  teleporters: 'teleporters.json',
  mobs: 'mobs.json',
  drops: 'drops.json',
  itemMap: 'itemmap-tam.json',
  uniques: 'uniques.json',
  safeAreas: 'safe-areas.json',
} as const

/** Default location: <parent of the client dir>/Random SRO Browser Remade/server/data. */
export function defaultPortDataDir(clientDir: string): string {
  return join(dirname(clientDir), 'Random SRO Browser Remade', 'server', 'data')
}

function readJson(dir: string, file: string): unknown {
  const path = join(dir, file)
  if (!existsSync(path)) throw new Error(`port data: ${path} not found (pass --port-data <dir>)`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function loadPortData(dir: string): PortData {
  const spawnsRaw = readJson(dir, PORT_FILES.spawns) as Record<string, unknown>
  const spawns: Record<string, PortNest[]> = {}
  for (const [zone, list] of Object.entries(spawnsRaw)) if (Array.isArray(list)) spawns[zone] = list as PortNest[]
  const shopsRaw = readJson(dir, PORT_FILES.shops) as { shops: Record<string, PortShopNpc>; zones?: Record<string, { npcs?: unknown }> }
  const shops = Object.values(shopsRaw.shops)
  const zoneNpcs: Record<string, PortZoneNpc[]> = {}
  for (const [zone, z] of Object.entries(shopsRaw.zones ?? {})) if (Array.isArray(z?.npcs)) zoneNpcs[zone] = z.npcs as PortZoneNpc[]
  const teleporters = (readJson(dir, PORT_FILES.teleporters) as { zones: Record<string, PortTeleporter[]> }).zones
  const mobs = (readJson(dir, PORT_FILES.mobs) as { mobs: PortMob[] }).mobs
  const d = readJson(dir, PORT_FILES.drops) as { $oranlar: PortDrops['rates']; dropTables: Record<string, PortDropTable> }
  const itemMap = readJson(dir, PORT_FILES.itemMap) as PortItemMap
  const uniques = (readJson(dir, PORT_FILES.uniques) as { uniques: PortUnique[] }).uniques
  const safeAreas = (readJson(dir, PORT_FILES.safeAreas) as { zones: Record<string, PortSafeArea[]> }).zones
  return {
    dir,
    safeAreas,
    spawns,
    shops,
    zoneNpcs,
    teleporters,
    mobs,
    drops: { rates: d.$oranlar, tables: Object.values(d.dropTables) },
    itemMap,
    uniques,
  }
}
