/**
 * The world editor's edit layers (docs/WORLD_EDITOR.md §3; docs/WAVE_PLAN8.md §2.5, §3.3, §4.1): constants and types.
 * Environment-neutral (no node:*, no @sro/formats): the editor page, the editor API and the converter share it.
 *
 * Folder `content/world-edits/<world>/`:
 *   edits.json                 the index (WorldEditsIndex)
 *   height/<x>_<z>.png         97 x 97 LA16: L = 32768 + round(dh * 256) (exact zero), A = touched
 *   paint/<x>_<z>.png          97 x 97 RGBA8: R = tile id & 0xff, G = (tile id >> 8) | tiling code << 2, A = painted
 *   grass/<x>_<z>.png          192 x 192 RGBA8 at 1 m: R = density x (R / 128), G = flowers, B = flower kind, A = touched
 *   walk/<x>_<z>.png           96 x 96 R8: 0 auto, 1 force open, 2 force closed
 *   placements.json            moves / drops of retail placements by (region, uid), adds by source path
 *   water.json, lights.json, zones.json, probes.json, palette.json (WE-U)
 * Every PNG has row 0 = north and column 0 = west (the coast's authored layers' convention); the grids here index
 * south-up: vertex gz * 97 + gx, tile tz * 96 + tx, texel z * 192 + x, as the terrain bin and the .nvm do.
 * Positions are glTF metres of the export's frame (x east, z = -north, origin = the south-west corner of
 * manifest.space.originRegion) unless a name says otherwise.
 */
import type { Vec3 } from '../protocol.ts'

export const WORLD_EDITS_FORMAT = 'sro-world-edits'
export const WORLD_EDITS_PLACEMENTS_FORMAT = 'sro-world-edits-placements'
export const WORLD_EDITS_VERSION = 1

/** Region edge (m), vertices per side, 2 m tiles per side, 1 m grass texels per side. */
export const WE_REGION_M = 192
export const WE_GRID = 97
export const WE_TILES = 96
export const WE_TILE_M = 2
export const WE_GRASS = 192
/** 6 x 6 water blocks of 32 m per region (the MAPM blocks); 16 tiles per block side. */
export const WE_BLOCKS = 6
export const WE_BLOCK_TILES = WE_TILES / WE_BLOCKS

/** Height delta code (§F1): L = 32768 + round(dh * 256); 1/256 m steps; -128 ... +127.996 m; exact zero. */
export const WE_HEIGHT_ZERO = 32768
export const WE_HEIGHT_STEPS_PER_M = 256
export const WE_HEIGHT_MIN_M = -WE_HEIGHT_ZERO / WE_HEIGHT_STEPS_PER_M
export const WE_HEIGHT_MAX_M = (0xffff - WE_HEIGHT_ZERO) / WE_HEIGHT_STEPS_PER_M

/** Terrain texture word (.m): tile2d id in bits 0-9, bits 10-12 zero, tiling code in bits 13-15. */
export const WE_TILE_ID_MASK = 0x3ff
export const WE_TILING_SHIFT = 13
export const WE_TILING_MAX = 7

/** Grass density: R / 128 multiplies GRASS_LIFE's density (x0 ... x1.99); 128 = unchanged. */
export const WE_GRASS_DENSITY_ONE = 128

/** Walkable override codes (walk/<x>_<z>.png, the Walkable tool §4.7). */
export const WE_WALK = { auto: 0, open: 1, closed: 2 } as const
export type WorldEditWalkCode = (typeof WE_WALK)[keyof typeof WE_WALK]

/** Editor uids per owner region (D11): 16-bit, because a nav instance id is regionId << 16 | uid. */
export const WE_EDITOR_UID_MIN = 0xe000
export const WE_EDITOR_UID_MAX = 0xefff

/** Uniform placement scale (D12, D17): trees 0.85-1.15, footprint-free props 0.5-2, never buildings. */
export const WE_TREE_SCALE: readonly [number, number] = [0.85, 1.15]
export const WE_PROP_SCALE: readonly [number, number] = [0.5, 2]

/** Brushes fade to zero over the last 8 m inside the export's outer regions (§7.3). */
export const WE_EDGE_FADE_M = 8

/** A move / drop whose stored `from` position is farther than this from the export's is "changed under your edit". */
export const WE_FROM_TOLERANCE_M = 0.01

/** Per-region guardrails (§7.2, D42): warn early, refuse late. */
export const WE_GUARDRAILS = {
  objectTriangles: { warn: 60_000, refuse: 90_000 },
  placements: { warn: 400, refuse: 600 },
  models: { warn: 60, refuse: 90 },
  separateDraws: { warn: 12, refuse: 20 },
  lightPointsWithin60m: { warn: 24, refuse: 48 },
  zonesPerPoint: { warn: 3, refuse: 4 },
  treeSlots: { warn: 7_500, refuse: 8_192 },
} as const

export type WorldEditLayerKind = 'height' | 'paint' | 'grass' | 'walk'
export const WE_LAYER_KINDS: readonly WorldEditLayerKind[] = ['height', 'paint', 'grass', 'walk']

/** `<kind>/<x>_<z>.png`, relative to the world's edits folder. */
export const worldEditLayerPath = (kind: WorldEditLayerKind, rx: number, rz: number) => `${kind}/${rx}_${rz}.png`


/** One region's height edit: per vertex (gz * 97 + gx) the delta in metres on the 1/256 m grid, and the touched mask. */
export interface HeightLayer {
  delta: Float32Array
  mask: Uint8Array
}

/** One region's paint: per vertex the texture word written where `mask` is set. */
export interface PaintLayer {
  words: Uint16Array
  mask: Uint8Array
}

/** One region's grass and flowers at 1 m (z * 192 + x): R density code, G flower amount, B flower kind, A touched. */
export interface GrassLayer {
  density: Uint8Array
  flowers: Uint8Array
  kind: Uint8Array
  mask: Uint8Array
}

/** One region's walkable overrides per tile (tz * 96 + tx), WE_WALK codes. */
export interface WalkLayer {
  codes: Uint8Array
}

/** edits.json: the index of a world's edits. */
export interface WorldEditsIndex {
  format: typeof WORLD_EDITS_FORMAT
  version: number
  world: string
  /** Every region with a layer file, with the SHA-256 (hex) of its exported heights before the edit pass. */
  regions: WorldEditsIndexRegion[]
  /** Counts by kind, informational. */
  counts?: Record<string, number>
  notes?: string
}

export interface WorldEditsIndexRegion {
  x: number
  z: number
  base: string
  layers: WorldEditLayerKind[]
}

/** A retail placement as the edits address it: owner region (z << 8 | x) and owner-unique uid. */
export interface WorldEditPlacementRef {
  region: number
  uid: number
}

/** Where a placement stood in the export when the edit was made (a mismatch after a re-export is a Publish error). */
export interface WorldEditFrom {
  position: Vec3
  yaw: number
}

export interface WorldEditTransform {
  position: Vec3
  /** Radians, file space (WorldPlacement.yaw). */
  yaw: number
  /** Uniform; absent = 1. */
  scale?: number
  /** Set when the origin left its owner region: the new owner and its fresh editor uid (§F5). */
  region?: number
  uid?: number
}

export interface WorldEditMove extends WorldEditPlacementRef {
  source: string
  from: WorldEditFrom
  to: WorldEditTransform
}

export interface WorldEditDrop extends WorldEditPlacementRef {
  source: string
  from: WorldEditFrom
}

export interface WorldEditAdd {
  /** `ed-<n>`, unique in the file. */
  id: string
  /** Model source path (object.ifo path); stable across exports. */
  source: string
  position: Vec3
  yaw: number
  scale?: number
  /** Owner region and editor uid, once assigned (assigned at lowering when absent). */
  region?: number
  uid?: number
}

/** placements.json */
export interface WorldEditPlacementsFile {
  format: typeof WORLD_EDITS_PLACEMENTS_FORMAT
  version: number
  world: string
  move: WorldEditMove[]
  drop: WorldEditDrop[]
  add: WorldEditAdd[]
}

/** water.json rows: a water plane per 32 m block at heightM (kind water). */
export interface WorldEditWater {
  id: string
  /** Region id z << 8 | x. */
  region: number
  /** [bx, bz], 0..5 each. */
  blocks: Array<[number, number]>
  heightM: number
}

export const WE_LIGHT_KINDS = ['lamp', 'lantern', 'fire'] as const
export type WorldEditLightKind = (typeof WE_LIGHT_KINDS)[number]

/** lights.json rows: free light points (S-NL). */
export interface WorldEditLight {
  id: string
  x: number
  y: number
  z: number
  kind: WorldEditLightKind
  /** Linear RGB 0..1. */
  colour: [number, number, number]
  intensity: number
  radiusM: number
}

export const WE_ZONE_WHEN = ['day', 'night', 'always'] as const
export type WorldEditZoneWhen = (typeof WE_ZONE_WHEN)[number]

export type WorldEditZoneShape =
  | { circle: { x: number; z: number; r: number } }
  | { poly: Array<[number, number]> }

/** zones.json rows: sound zones (WE-R). */
export interface WorldEditZone {
  id: string
  name: string
  shape: WorldEditZoneShape
  /** A key of the exported sound index. */
  sound: string
  gainDb: number
  fadeM: number
  when: WorldEditZoneWhen
}

/** probes.json rows: points that must stay reachable from the town spawn, both ways. */
export interface WorldEditProbe {
  id: string
  name: string
  x: number
  z: number
  y?: number
}

/** Validator result: problems name the path, e.g. `placements.move[2].to.scale: ...`. */
export interface WorldEditCheck {
  ok: boolean
  problems: string[]
}
