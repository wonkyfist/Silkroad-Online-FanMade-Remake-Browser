/**
 * Schema of work/out/world/<name>/manifest.json, written by `pnpm sro convert-region` (./convert-world.ts).
 *
 * Environment-neutral (no node:* imports) so the viewer can import these types and validateWorldManifest through a
 * relative path. The binary files the manifest points to are described (and decoded) in ./format.ts.
 *
 * Space (docs/CONVENTIONS.md "World space & region output"): everything is glTF space, right-handed, +Y up, metres,
 * produced by packages/convert/src/gltf/space.ts (file space (x, y, z) -> 0.1 (x, y, -z)). File-space +X (east)
 * stays +X; file-space +Z (north) becomes glTF -Z. The floating origin is the south-west corner (file-space
 * region-local (0, 0, 0): minimum x, minimum z) of `space.originRegion`, at height 0.
 */

export const WORLD_MANIFEST_FORMAT = 'sro-world'
export const WORLD_MANIFEST_VERSION = 1

export type Vec3 = [x: number, y: number, z: number]
export type Quat = [x: number, y: number, z: number, w: number]

export interface WorldManifest {
  format: typeof WORLD_MANIFEST_FORMAT
  version: typeof WORLD_MANIFEST_VERSION
  /** Output name (the folder under work/out/world). */
  name: string
  generator: string
  /** ISO timestamp of the conversion. */
  createdAt: string
  space: WorldSpace
  /** Converted regions, ordered by z then x. */
  regions: WorldRegion[]
  /** Terrain tile textures used by the converted regions (each decoded once, shared). */
  tiles: TileTexture[]
  water: WaterAssets
  /** environment.json: the environment.ifo profiles the regions' blocks reference. */
  environment: { file: string; profileIds: number[] }
  /** One entry per unique converted resource (.bsr); placements index this array. */
  models: WorldModel[]
  /** Deduplicated object placements (.o2), ordered by owner region then uid. */
  placements: WorldPlacement[]
  /**
   * Navigation (additive; absent in older manifests and when converted with navmesh: false): the @sro/nav NavData
   * of the converted regions. The per-region navmesh bins (WorldRegion.navmesh) are still written.
   */
  nav?: WorldNav
  /** Where new characters appear (additive; absent when no return point lies in the converted regions). */
  spawn?: WorldSpawn
  /** Display name of the world (additive; apps/server content.ts resolveWorld prefers it over the folder name). */
  displayName?: string
  /**
   * Playable rectangle (glTF metres; additive, docs/FIELDS.md §3.9): the server clamps every move to it (apps/server
   * content.ts reads `bounds`). Absent: the union of the regions.
   */
  bounds?: WorldBounds
  /** Region streaming data (additive; absent: load the whole world as before). */
  stream?: WorldStream
  /** Named points for GM `tp <name>` (additive; apps/server content.ts manifestPlaces reads `places`). glTF metres. */
  places?: WorldPlace[]
  /**
   * The sea around the export (additive, docs/COAST.md §8.1; absent: no coast pass ran, the world has no ocean). Written
   * by the converter's coast pass (./coast/, CST-C) when WorldPreset.coast names a coast config.
   */
  coast?: WorldCoast
  /**
   * The town's content files copied into the export (additive, wave 11, docs/TOWN_LIFE.md §2.4; absent: no town
   * content, and every older export). The client loads them by these names next to the manifest.
   */
  town?: WorldTown
  /** Non-fatal problems (failed models, missing files, dedupe conflicts...). */
  warnings: string[]
  report: WorldReport
}

/**
 * nav.bin: @sro/nav NavData encoded with encodeNavData ('SRNV'; decodeNavData reads it). Coordinates inside are
 * world FILE space (x east, z north, y up, 1 unit = 1 dm, world = 1920 (rx, rz) + region-local), the frame of the
 * native rules; `new NavGltf(new NavWorld(decodeNavData(bytes)), space.originRegion)` answers in this manifest's glTF
 * metres. Contents: the terrain .nvm of every converted region plus every object navmesh instance their object
 * lists name (big objects owned by neighbouring regions and .cpd compounds, via their collision .bsr, included).
 */
export interface WorldNav {
  /** Relative to the manifest. */
  file: string
  format: 'SRNV'
  /** NAV_DATA_VERSION of @sro/nav. */
  version: number
  bytes: number
  space: 'file'
  /** Region ids (z << 8 | x) with terrain navigation, in file order. */
  regions: number[]
  models: number
  instances: number
  /** Instances owned by a region outside `regions` (big objects overhanging from a neighbour). */
  neighbourInstances: number
  /** Instances whose object is a .cpd compound (navmesh = its collision .bsr's collision mesh). */
  compoundInstances: number
  /** Object-to-object navmesh links. */
  links: number
}

/**
 * Spawn point of new characters, glTF metres in this manifest's frame (the game server reads x/y/z). y lies on the
 * navigation surface: NavGltf.locate(x, z, y) returns y itself. yaw: radians, @sro/shared yawTowards convention
 * (atan2(dx, dz): 0 faces glTF +Z = south). source: where the point comes from.
 */
export interface WorldSpawn {
  x: number
  y: number
  z: number
  yaw: number
  source: string
}

/** Axis-aligned rectangle in glTF metres. */
export interface WorldBounds {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/**
 * Region streaming data (docs/FIELDS.md §3.9). `regions`, `tiles`, `models` and `placements` stay complete for the
 * whole export, so non-streaming loaders keep working; a streaming loader derives per-region placement lists from
 * `placements[].region` in one pass.
 */
export interface WorldStream {
  /** Region rectangle the server simulates (manifest `bounds` in region units, inclusive). */
  playable: { x0: number; x1: number; z0: number; z1: number }
  /**
   * Per-region SRNV chunks: `${dir}/${x}_${z}.bin`, each exactly one NavRegion of nav.bin (models: [], instances: []),
   * one for every region of manifest.nav.regions. `bytes`: the sum over all chunks.
   */
  navRegions: { dir: string; bytes: number }
  /** SRNV with regions: [] and every model/instance/link of nav.bin, in nav.bin's instance order. */
  navObjects: { file: string; bytes: number }
  /**
   * Overview image for the world map: the client minimap tiles stitched north-up at `pxPerRegion` px per region (each
   * 256² tile box-filtered down). Pixel (0, 0) is the north-west corner of region (x0, z1); region (x, z) covers
   * columns from (x - x0) pxPerRegion and rows from (z1 - z) pxPerRegion. Inactive regions and regions without a
   * tile are filled with #202225. width = (x1 - x0 + 1) pxPerRegion, height = (z1 - z0 + 1) pxPerRegion.
   */
  worldMap: { file: string; pxPerRegion: number; x0: number; x1: number; z0: number; z1: number; width: number; height: number } | null
  /** Suggested streaming radii (metres, distance from the focus to a region rectangle) for the medium preset. */
  loadRadiusM: number
  unloadRadiusM: number
}

/**
 * A named point for GM `tp` (docs/FIELDS.md §4.6): one per client zone name (textzonename.txt) as a lower-case slug,
 * at the mean centre of the zone's playable regions, snapped onto open terrain in the town spawn's walkable component.
 */
export interface WorldPlace {
  name: string
  x: number
  y: number
  z: number
  source: string
}

/**
 * manifest.coast (docs/COAST.md §8.1): the coast field over the coast pass's computation domain. glTF metres in this
 * manifest's frame.
 */
export interface WorldCoast {
  /** The sea level (glTF y, metres). */
  seaLevelM: number
  /**
   * coast/field.png, RGBA8, world-aligned: R sea mask (255 = sea), G distance to the shore (0.5 m steps, signed by R),
   * B bed depth below the sea level on sea texels / height above it on land within 128 m (0.2 m steps), A breaker and
   * foam authoring. `x0`, `z0`: the glTF corner at the minimum x and minimum z (north-west, since north = -z); PNG
   * column 0 = x0 (west) and row 0 = z0 (north), +column = +x, +row = +z; `metresPerTexel` per texel, `width` × `height`
   * texels.
   */
  field: { file: string; x0: number; z0: number; metresPerTexel: number; width: number; height: number }
  /** Minimap / world-map fill for open sea, '#rrggbb'. */
  mapColor: string
  /** Hash of coast.json + content/coast/**, for staleness checks (the Blender round trip, docs/COAST.md §6.4). */
  sourceHash: string
}

export interface WorldSpace {
  units: 'metre'
  /** 0.1: one file unit is a decimetre (space.ts UNIT_SCALE). */
  metresPerUnit: number
  handedness: 'right-handed, +Y up (glTF)'
  /** Compass in glTF space: east = +X, north = -Z (file-space +Z mirrored by space.ts), up = +Y. */
  axes: { east: Vec3; north: Vec3; up: Vec3 }
  /** Region whose south-west corner is the floating origin. */
  originRegion: { x: number; z: number; id: number }
  /** Always 'south-west': file-space region-local (0, 0, 0) of originRegion (its minimum x and minimum z). */
  originCorner: 'south-west'
  /** Region edge: 1920 units = 192 m. */
  regionSizeM: number
  /** Terrain cell (tile) edge: 20 units = 2 m; 96 cells, 97 vertices per region side. */
  cellSizeM: number
  /** Human-readable statement of the region -> world rule (see WorldRegion.origin). */
  regionOffsetRule: string
  /** Human-readable statement of region-local file units -> glTF world. */
  localToWorldRule: string
}

export interface WorldRegion {
  x: number
  z: number
  /** z << 8 | x. */
  id: number
  /**
   * glTF position (m) of the region's south-west corner, file-space local (0, 0, 0):
   * space.ts toGltfPosition([1920 (x - originX), 0, 1920 (z - originZ)]) = [192 (x - originX), 0, -192 (z - originZ)].
   * Local (lx, h, lz) in file units maps to [origin[0] + 0.1 lx, 0.1 h, origin[2] - 0.1 lz].
   */
  origin: Vec3
  /** glTF axis-aligned bounds of the terrain (m). */
  bounds: { min: Vec3; max: Vec3 }
  terrain: {
    /** Relative to the manifest: the TerrainBin (format.ts) of this region. */
    file: string
    bytes: number
    /** Terrain height range in metres. */
    heightMinM: number
    heightMaxM: number
    /** Number of 96 x 96 layer planes in the file (native per-cell layering, TERRAIN.md 2.3). */
    layerCount: number
    /** Distinct tile2d ids used (see WorldManifest.tiles). */
    tileIds: number[]
  }
  /**
   * The .t lightmap as PNG (512 x 512 RGBA). PNG row 0 = the region's SOUTH edge (file z = 0), column 0 = west.
   * Border texels are shared with the neighbour, so texel centres lie on the region border:
   * u = (0.5 + 511 lx / 1920) / 512, v = (0.5 + 511 lz / 1920) / 512, with v = 0 at PNG row 0 (load with invertY
   * false). Terrain colour = tiles x saturate(lightmap + TerrainShadowColor) (TERRAIN.md 3.1). null: no .t file (use
   * white).
   */
  lightmap: { file: string; width: number; height: number } | null
  /** Client minimap tile (256 x 256 PNG, NORTH-up: row 0 = file z 1920), for debugging/verification. */
  minimap: string | null
  /** 36 blocks of 320 x 320 units (32 m), index bz * 6 + bx (bx east, bz north). */
  blocks: TerrainBlock[]
  navmesh: RegionNavmesh | null
  /**
   * Additive (docs/COAST.md §5.4): the region is not a retail region but was emitted by the coast pass (sea, beach or
   * shelf beyond the retail export, or an inactive retail hole it filled). Absent on retail regions.
   */
  synthetic?: true
  /**
   * Additive (wave 12, docs/WAVE_PLAN8.md §3.2, docs/WORLD_EDITOR.md D55): the region's 1 m grass/flower mask painted in
   * the World Editor (relative to the manifest), multiplied into the grass bake on Medium+. Absent: not painted.
   */
  grassMask?: string
  /**
   * Additive (wave 12, docs/WORLD_EDITOR.md D13): how many of ambient.json's free light `points` this region owns.
   * Absent: none.
   */
  lightPoints?: number
}

export interface TerrainBlock {
  bx: number
  bz: number
  /** Raw .m block flag (0; 1 = "culled" per the wiki, only 168,97 blocks 14/15). */
  flag: number
  /** environment.ifo profile id (see WorldManifest.environment). */
  environmentId: number
  /** Flat plane over the whole block, visible where the terrain is below it (TERRAIN.md 4); null = none. */
  water: { kind: 'water' | 'ice'; type: number; wave: number; heightM: number } | null
}

export interface RegionNavmesh {
  /** Relative to the manifest: the NavmeshBin (format.ts). */
  file: string
  bytes: number
  cells: number
  /** cells[0 .. openCells) are walkable, the rest blocked. */
  openCells: number
  globalEdges: number
  internalEdges: number
  objects: number
  /** 6 x 6 water/ice planes (index bz * 6 + bx): NVM_PLANE_TYPE 0 none, 1 water, 2 ice, 3 water+ice; null if absent. */
  planes: Array<{ type: number; heightM: number }> | null
}

export interface TileTexture {
  /** tile2d.ifo id: low 10 bits of the .m vertex texture word. */
  id: number
  /** DDJ file inside Map.pk2 tile2d/. */
  source: string
  /** Relative to the manifest. RGBA PNG, rows in DDS order (row 0 at v = 0, not flipped). */
  file: string
  width: number
  height: number
  /** Surface material (footsteps), not used for rendering. */
  typeName: string | null
  category: string
  /**
   * Additive (docs/GRASS_LIFE.md §3.2, §3.5; the converter's grass pass, ./grass.ts, GL-C): how much the new grass grows
   * on this tile and its painterly palette. Absent: the runtime falls back to its built-in palettes.
   */
  grass?: TileGrass
}

/** A terrain tile's grass: weight 0 (bare: sand, road, rock) .. 1 (full grass), and the blade palette. */
export interface TileGrass {
  weight: number
  /** Blade base colour (the tile image's dark decile), sRGB 0..1. */
  base: Vec3
  /** Blade tip colour (the tile image's light decile), sRGB 0..1. */
  tip: Vec3
}

export interface WaterAssets {
  /** Map/water/water101..130 as PNG (64 x 64), animated at frameMs per frame (TERRAIN.md 4). */
  frames: string[]
  frameMs: number
  /** water201 (ice), or null. */
  ice: string | null
  /** wave1..3 (use unknown). */
  waves: string[]
}

export interface WorldModel {
  /** Index in WorldManifest.models. */
  index: number
  /** Data.pk2 resource path as stored (backslashes). */
  source: string
  /** Relative to the manifest; null when the conversion failed (see error). */
  glb: string | null
  /** Sidecar JSON (gltf/convert.ts Sidecar), relative to the manifest; null when failed. */
  sidecar: string | null
  /** 'static': plain node hierarchy; 'skinned': skeleton + clips (loop defaultClip). */
  kind: 'static' | 'skinned' | 'failed'
  animations: string[]
  /** The clip to loop for world objects: the first clip of the 'default' aniGroup, else the first clip. */
  defaultClip: string | null
  /**
   * Meshes carrying TEXCOORD_1 + material extras.sroLightmap = { path, uri, texCoord: 1 } (gltf/convert.ts
   * LightmapExtras). uri is relative to manifest.json (lightmaps/<Data path>.png, RGBA, rows as stored, uv1 in [0, 1]).
   * Babylon: material.lightmapTexture = that texture with coordinatesIndex 1 (TERRAIN.md 3.3: combine unknown,
   * texel statistics favour a 1x multiply; keep an off/1x/2x toggle).
   */
  lightmappedMeshes: number
  /** Model-space glTF bounds (m). */
  boundsMin: Vec3
  boundsMax: Vec3
  bytes: number
  validatorErrors: number | null
  error?: string
  /**
   * Additive (docs/BATCHING.md §3.5; the converter's static-variant pass, ./static-variants.ts, BT-C): on a skinned
   * foliage model, the index of its static variant (the posed mesh at frame 0 of the default clip, skin removed; a
   * 'static' model). Medium+ load the variant instead. Absent: no variant.
   */
  staticVariant?: number
  /**
   * Additive (wave 11, docs/TOWN_LIFE.md §5.1; the converter's cloth pass, ./town/cloth.ts, TL-M): the model's
   * materials that sway as cloth, by glTF material name, with their kind and (optionally) the pin line in model space.
   * The batcher reclasses them to the cloth class and gives each piece its own pivot. Absent: no cloth reclass.
   */
  cloth?: WorldModelCloth[]
  /**
   * Additive (wave 12, docs/TREES.md WF11, WF12; the converter's tree-swap step, ./trees-manifest.ts, T12-A): on a retail
   * tree or plant, the new species that replaces it on Medium+ (`graphics.trees: 'new'`), appended as a manifest model.
   * A model with `treeSwap` is always a tree claim. Low and 'retail' ignore it. Absent: drawn as retail.
   */
  treeSwap?: WorldModelTreeSwap
  /**
   * Additive (DRAGON-INT, docs/REMASTER.md "World models"; the converter's remaster step, ./remaster-models.ts): on a
   * static retail model, the index of its remastered replacement (a 'static' model appended by the converter, `source`
   * = this one's + '#remaster', in this model's own space). The PBR path (Medium+) loads it in this model's place
   * (world-render batch/remaster.ts); Low / Classic draws this model. Absent: drawn as retail.
   */
  remasterVariant?: number
}

/** WorldModel.treeSwap. */
export interface WorldModelTreeSwap {
  /** Index of the species model (a static model appended by the tree-swap step). */
  model: number
  /** Per-axis scale (x, y, z) fitting the species to this retail model's envelope. */
  fit: Vec3
  /** The crown tint for this retail source (0 = the species' own sprites, k >= 1 = its k-th tint). */
  tint: number
  /** Model-space offset (m) of the species' trunk base from the retail one (docs/TREES.md WF20). Absent: [0, 0, 0]. */
  offset?: Vec3
}

/** Cloth sway kinds: pinned along the top (flags, banners, signs), along the high edge (awnings), at the base (tents). */
export type WorldClothKind = 'hanging' | 'awning' | 'tent'
export const WORLD_CLOTH_KINDS: readonly WorldClothKind[] = ['hanging', 'awning', 'tent']

export interface WorldModelCloth {
  /** glTF material name in the model's glb. */
  material: string
  kind: WorldClothKind
  /** Model-space y (m) of the pin line (hanging, awning: the top; tent: the base). Absent: from the piece's bounds. */
  pinY?: number
  /** Swaying height (m) below (or, for a tent, above) the pin. Absent: from the piece's bounds. */
  height?: number
}

/** manifest.town (wave 11): files relative to the manifest; null = that file is not part of the export. */
export interface WorldTown {
  /** The town file (kind 'town': graph, places, folk, schedule, lines), e.g. 'town.json'. */
  file: string | null
  /** The dressing file (kind 'townDressing': props, banners, lamps, decals, crack bands, pond), e.g. 'town-dressing.json'. */
  dressing: string | null
}

export interface WorldPlacement {
  /** object.ifo index. */
  objId: number
  /** object.ifo path (.bsr or .cpd). */
  source: string
  /** Indices into WorldManifest.models, all drawn with this placement's transform (several for a .cpd). */
  models: number[]
  /** Set when source is a .cpd compound (its children are `models`). */
  compound: boolean
  /** glTF translation (m) relative to the floating origin: space.ts toGltfPosition of the file-space world offset. */
  position: Vec3
  /** glTF rotation: space.ts toGltfQuat(mapoYawQuat(yaw)) = +yaw about +Y. */
  rotation: Quat
  /** Raw yaw (radians, file space). */
  yaw: number
  flags: {
    /** staticFlag === 0xFFFF. 0 means animated (TERRAIN.md 6.2). */
    static: boolean
    /** isBig: the object extends beyond its region. */
    big: boolean
    /** isStruct: named in objectstring.ifo. */
    struct: boolean
  }
  staticFlag: number
  /** Owner-region-unique id. */
  uid: number
  /** Owner region id (z << 8 | x); may lie outside the converted set for overhanging neighbours. */
  region: number
  /** Culling group: 2 large (draw < 2020 units), 3 small (< 480 units). */
  group: number
  /** The owner region is one of the converted regions. */
  inConvertedRegion: boolean
  /**
   * Additive (wave 12, S-SCALE, docs/WORLD_EDITOR.md D12, docs/WAVE_PLAN8.md D17): a uniform scale set in the World
   * Editor (0.85-1.15 for trees, 0.5-2 for footprint-free props; never buildings). The nav keeps the unscaled
   * footprint. Absent: 1.
   */
  scale?: number
}

/** WorldPlacement.scale's allowed range (the validator's; the editor's per-kind ranges lie inside it). */
export const PLACEMENT_SCALE_MIN = 0.5
export const PLACEMENT_SCALE_MAX = 2

export interface WorldReport {
  regions: number
  regionsSkipped: string[]
  /** .o2 records read across the converted regions' files (every block/group repeat counted). */
  placementRecords: number
  /** Unique placements after the (regionId, uid) dedupe. */
  placements: number
  /** Records whose (regionId, uid) repeated with a different objId or position (kept the first). */
  dedupeConflicts: number
  uniqueObjectIds: number
  compoundPlacements: number
  uniqueModels: number
  modelsConverted: number
  failedModels: Array<{ source: string; error: string }>
  lightmapTextures: number
  tileTextures: number
  validatorErrors: number
  sizes: { totalBytes: number; byCategory: Record<string, number> }
  timeMs: { total: number; terrain: number; navmesh: number; objects: number; textures: number; nav?: number; stream?: number }
  /** Additive (docs/COAST.md §5.4, §12.13): what the coast pass changed. Absent when no coast pass ran. */
  coast?: WorldCoastReport
  /** Additive (wave 11): what the town dressing and cloth passes changed. Absent when neither ran. */
  town?: WorldTownReport
  /** Additive (wave 12): what the world-edits pass changed. Absent when it did not run. */
  edits?: WorldEditsReport
  /** Additive (wave 12): the tree-swap step's counts. Absent when it did not run. */
  trees?: WorldTreesReport
  /** Additive (DRAGON-INT): the remastered models appended (./remaster-models.ts). Absent when the step did not run. */
  remasterModels?: WorldRemasterModelsReport
}

/** report.remasterModels: one row per remastered model (the retail source, the variant's glb and its bytes). */
export type WorldRemasterModelsReport = Array<{ source: string; glb: string; bytes: number }>

/**
 * report.edits (wave 12): the edits' placement changes (the C9 shape; a move is listed as dropped and added), the models
 * they added, the static variants made for them, and (./convert-world.ts) the edited footprints the nav disagrees on.
 */
export interface WorldEditsReport {
  placements: WorldCoastReport['placements']
  models: number
  staticVariants: number
  /** ./passes.ts editedFootprintProblems (0 = the nav step and the pass agree). Absent: not checked (no nav). */
  footprintProblems?: number
  /** Further keys from the edits run (WE-D: regions touched, masks, points, ...). */
  [key: string]: unknown
}

/** report.trees (wave 12): species appended, retail models given a `treeSwap`. */
export interface WorldTreesReport {
  species: number
  swapped: number
}

/** report.town: the dressing's placement edits (the C9 shape), the models it added and the models reclassed as cloth. */
export interface WorldTownReport {
  placements: WorldCoastReport['placements']
  models: number
  clothModels: number
  /** Ambient rows written for the dressing's lamps (./ambient.ts). */
  lampRows?: number
}

/**
 * report.coast. `placements` is filled by the pass pipeline (./passes.ts) from the C9 edits it applied; the coast pass
 * adds its census (emitted and changed regions, hotspots, in-bounds changes, ...) as further keys.
 */
export interface WorldCoastReport {
  placements: {
    /** Placements removed (their ground went under the sea or moved by more than dropMovedM). */
    dropped: Array<{ region: number; uid: number }>
    /** Placements moved onto the new ground: glTF y before and after. */
    resnapped: Array<{ region: number; uid: number; fromY: number; toY: number }>
    /** Coast props added. */
    added: Array<{ region: number; uid: number }>
  }
  [key: string]: unknown
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isVec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(isNum)

/**
 * Runtime check of a parsed manifest against the types above. Returns the problems found (empty = valid), including
 * cross-references (placement model indices, block counts, unit quaternions).
 */
export function validateWorldManifest(m: unknown): string[] {
  const errors: string[] = []
  const err = (path: string, what: string) => {
    if (errors.length < 200) errors.push(`${path}: ${what}`)
  }
  if (!isObj(m)) return ['manifest: not an object']
  if (m.format !== WORLD_MANIFEST_FORMAT) err('format', `expected ${WORLD_MANIFEST_FORMAT}`)
  if (m.version !== WORLD_MANIFEST_VERSION) err('version', `expected ${WORLD_MANIFEST_VERSION}`)
  for (const k of ['name', 'generator', 'createdAt']) if (!isStr(m[k])) err(k, 'expected a string')

  const space = m.space
  if (!isObj(space)) err('space', 'expected an object')
  else {
    if (space.units !== 'metre') err('space.units', 'expected metre')
    if (space.metresPerUnit !== 0.1) err('space.metresPerUnit', 'expected 0.1')
    if (space.originCorner !== 'south-west') err('space.originCorner', 'expected south-west')
    if (!isObj(space.axes) || !isVec(space.axes.east, 3) || !isVec(space.axes.north, 3) || !isVec(space.axes.up, 3)) {
      err('space.axes', 'expected east/north/up vectors')
    }
    const o = space.originRegion
    if (!isObj(o) || !isNum(o.x) || !isNum(o.z) || o.id !== ((o.z as number) << 8 | (o.x as number))) {
      err('space.originRegion', 'expected {x, z, id = z << 8 | x}')
    }
    for (const k of ['regionSizeM', 'cellSizeM']) if (!isNum(space[k])) err(`space.${k}`, 'expected a number')
    for (const k of ['regionOffsetRule', 'localToWorldRule']) if (!isStr(space[k])) err(`space.${k}`, 'expected a string')
  }

  const models = Array.isArray(m.models) ? m.models : (err('models', 'expected an array'), [])
  models.forEach((md: unknown, i: number) => {
    const p = `models[${i}]`
    if (!isObj(md)) return err(p, 'expected an object')
    if (md.index !== i) err(`${p}.index`, `expected ${i}`)
    if (!isStr(md.source)) err(`${p}.source`, 'expected a string')
    if (md.kind !== 'static' && md.kind !== 'skinned' && md.kind !== 'failed') err(`${p}.kind`, 'bad kind')
    if (md.kind === 'failed') {
      if (!isStr(md.error)) err(`${p}.error`, 'failed model without error')
    } else {
      if (!isStr(md.glb) || !isStr(md.sidecar)) err(p, 'converted model without glb/sidecar')
    }
    if (!Array.isArray(md.animations) || !md.animations.every(isStr)) err(`${p}.animations`, 'expected string[]')
    if (md.defaultClip !== null && !(isStr(md.defaultClip) && (md.animations as string[]).includes(md.defaultClip))) {
      err(`${p}.defaultClip`, 'must be null or one of animations')
    }
    if (!isVec(md.boundsMin, 3) || !isVec(md.boundsMax, 3)) err(p, 'bad bounds')
    if (!isNum(md.bytes) || !isNum(md.lightmappedMeshes)) err(p, 'bad bytes/lightmappedMeshes')
    if (md.staticVariant !== undefined) {
      const v = md.staticVariant
      const target = Number.isInteger(v) ? models[v as number] : undefined
      if (md.kind !== 'skinned') err(`${p}.staticVariant`, 'only a skinned model has a static variant')
      if (v === i || !isObj(target)) err(`${p}.staticVariant`, 'expected the index of another model')
      else if (target.kind !== 'static') err(`${p}.staticVariant`, `model ${v} is not static`)
    }
    if (md.cloth !== undefined) {
      const ok = Array.isArray(md.cloth) && md.cloth.length > 0 && md.cloth.every(c => isObj(c) && isStr(c.material) && c.material.length > 0 &&
        WORLD_CLOTH_KINDS.includes(c.kind as WorldClothKind) && (c.pinY === undefined || isNum(c.pinY)) &&
        (c.height === undefined || (isNum(c.height) && c.height > 0)))
      if (!ok) err(`${p}.cloth`, `expected [{material, kind: ${WORLD_CLOTH_KINDS.join(' | ')}, pinY?, height? > 0}]`)
      if (md.kind === 'failed') err(`${p}.cloth`, 'a failed model has no cloth')
    }
    if (md.treeSwap !== undefined) {
      const ts = md.treeSwap
      const target = isObj(ts) && Number.isInteger(ts.model) ? models[ts.model as number] : undefined
      if (!isObj(ts) || !isVec(ts.fit, 3) || !(ts.fit as number[]).every(v => v > 0) || !isNum(ts.tint) ||
        (ts.offset !== undefined && !isVec(ts.offset, 3))) {
        err(`${p}.treeSwap`, 'expected {model, fit: [3 numbers > 0], tint, offset?: [3 numbers]}')
      } else if (ts.model === i || !isObj(target)) err(`${p}.treeSwap.model`, 'expected the index of another model')
      else if (target.kind !== 'static') err(`${p}.treeSwap.model`, `model ${ts.model} is not static`)
      else if (target.treeSwap !== undefined) err(`${p}.treeSwap.model`, `model ${ts.model} is itself swapped`)
      if (md.kind === 'failed') err(`${p}.treeSwap`, 'a failed model has no swap')
    }
    if (md.remasterVariant !== undefined) {
      const v = md.remasterVariant
      const target = Number.isInteger(v) ? models[v as number] : undefined
      if (md.kind !== 'static') err(`${p}.remasterVariant`, 'only a static model has a remaster variant')
      if (v === i || !isObj(target)) err(`${p}.remasterVariant`, 'expected the index of another model')
      else if (target.kind !== 'static' || !isStr(target.glb)) err(`${p}.remasterVariant`, `model ${v} is not a converted static model`)
      else if (target.remasterVariant !== undefined) err(`${p}.remasterVariant`, `model ${v} is itself remastered`)
      else if (target.source !== `${md.source as string}#remaster`) err(`${p}.remasterVariant`, `model ${v} is not this model's #remaster variant`)
    }
  })

  const regions = Array.isArray(m.regions) ? m.regions : (err('regions', 'expected an array'), [])
  regions.forEach((r: unknown, i: number) => {
    const p = `regions[${i}]`
    if (!isObj(r)) return err(p, 'expected an object')
    if (!isNum(r.x) || !isNum(r.z) || r.id !== ((r.z as number) << 8 | (r.x as number))) err(p, 'bad x/z/id')
    if (!isVec(r.origin, 3)) err(`${p}.origin`, 'expected Vec3')
    if (!isObj(r.bounds) || !isVec(r.bounds.min, 3) || !isVec(r.bounds.max, 3)) err(`${p}.bounds`, 'bad bounds')
    const t = r.terrain
    if (!isObj(t) || !isStr(t.file) || !isNum(t.bytes) || !isNum(t.heightMinM) || !isNum(t.heightMaxM) ||
      !isNum(t.layerCount) || !Array.isArray(t.tileIds) || !t.tileIds.every(isNum)) err(`${p}.terrain`, 'bad terrain entry')
    if (r.lightmap !== null && !(isObj(r.lightmap) && isStr(r.lightmap.file) && isNum(r.lightmap.width) && isNum(r.lightmap.height))) {
      err(`${p}.lightmap`, 'bad lightmap entry')
    }
    if (r.minimap !== null && !isStr(r.minimap)) err(`${p}.minimap`, 'expected string or null')
    if (!Array.isArray(r.blocks) || r.blocks.length !== 36) err(`${p}.blocks`, 'expected 36 blocks')
    else r.blocks.forEach((b: unknown, k: number) => {
      const bp = `${p}.blocks[${k}]`
      if (!isObj(b) || b.bx !== k % 6 || b.bz !== Math.floor(k / 6)) return err(bp, 'bad bx/bz (index bz * 6 + bx)')
      if (!isNum(b.flag) || !isNum(b.environmentId)) err(bp, 'bad flag/environmentId')
      const w = b.water
      if (w !== null && !(isObj(w) && (w.kind === 'water' || w.kind === 'ice') && isNum(w.type) && isNum(w.wave) && isNum(w.heightM))) {
        err(`${bp}.water`, 'bad water entry')
      }
    })
    const n = r.navmesh
    if (n !== null) {
      if (!isObj(n) || !isStr(n.file) || !isNum(n.cells) || !isNum(n.openCells) || (n.openCells as number) > (n.cells as number)) {
        err(`${p}.navmesh`, 'bad navmesh entry')
      } else if (n.planes !== null && !(Array.isArray(n.planes) && n.planes.length === 36)) err(`${p}.navmesh.planes`, 'expected 36 or null')
    }
    if (r.grassMask !== undefined && !isRelPath(r.grassMask)) err(`${p}.grassMask`, 'expected a relative path (no ..)')
    if (r.lightPoints !== undefined && !(isInt(r.lightPoints) && r.lightPoints >= 0)) err(`${p}.lightPoints`, 'expected an integer >= 0')
  })
  const navIds = isObj(m.nav) && Array.isArray(m.nav.regions) ? new Set(m.nav.regions as number[]) : new Set<number>()
  const playable = isObj(m.stream) && isObj(m.stream.playable) ? m.stream.playable : null
  regions.forEach((r: unknown, i: number) => {
    if (!isObj(r) || r.synthetic === undefined) return
    if (r.synthetic !== true) return err(`regions[${i}].synthetic`, 'expected true or absent')
    // a synthetic region (docs/COAST.md §9.1) has no navigation and never lies in the playable rectangle
    if (r.navmesh !== null) err(`regions[${i}].navmesh`, 'a synthetic region has no navmesh')
    if (isNum(r.id) && navIds.has(r.id)) err(`regions[${i}]`, 'a synthetic region is not in nav.regions')
    if (playable && isNum(r.x) && isNum(r.z) && isNum(playable.x0) && isNum(playable.x1) && isNum(playable.z0) && isNum(playable.z1) &&
      r.x >= playable.x0 && r.x <= playable.x1 && r.z >= playable.z0 && r.z <= playable.z1) err(`regions[${i}]`, 'a synthetic region lies in stream.playable')
  })

  const tiles = Array.isArray(m.tiles) ? m.tiles : (err('tiles', 'expected an array'), [])
  const tileIds = new Set<number>()
  tiles.forEach((t: unknown, i: number) => {
    if (!isObj(t) || !isNum(t.id) || !isStr(t.file) || !isStr(t.source) || !isNum(t.width) || !isNum(t.height)) {
      return err(`tiles[${i}]`, 'bad tile entry')
    }
    tileIds.add(t.id)
    if (t.grass !== undefined) {
      const g = t.grass
      const unit = (v: unknown) => isNum(v) && v >= 0 && v <= 1
      const colour = (v: unknown) => isVec(v, 3) && (v as number[]).every(unit)
      if (!isObj(g) || !unit(g.weight) || !colour(g.base) || !colour(g.tip)) {
        err(`tiles[${i}].grass`, 'expected {weight 0..1, base and tip sRGB 0..1}')
      }
    }
  })
  regions.forEach((r: unknown, i: number) => {
    if (!isObj(r) || !isObj(r.terrain) || !Array.isArray(r.terrain.tileIds)) return
    for (const id of r.terrain.tileIds) if (!tileIds.has(id as number)) err(`regions[${i}].terrain.tileIds`, `tile ${id} not in tiles`)
  })

  const water = m.water
  if (!isObj(water) || !Array.isArray(water.frames) || !water.frames.every(isStr) || !isNum(water.frameMs)) err('water', 'bad water assets')
  if (!isObj(m.environment) || !isStr(m.environment.file) || !Array.isArray(m.environment.profileIds)) err('environment', 'bad environment')

  const placements = Array.isArray(m.placements) ? m.placements : (err('placements', 'expected an array'), [])
  placements.forEach((pl: unknown, i: number) => {
    const p = `placements[${i}]`
    if (!isObj(pl)) return err(p, 'expected an object')
    if (!isNum(pl.objId) || !isStr(pl.source)) err(p, 'bad objId/source')
    if (!Array.isArray(pl.models) || !pl.models.every(k => Number.isInteger(k) && (k as number) >= 0 && (k as number) < models.length)) {
      err(`${p}.models`, 'model index out of range')
    }
    if (!isVec(pl.position, 3)) err(`${p}.position`, 'expected Vec3')
    if (!isVec(pl.rotation, 4)) err(`${p}.rotation`, 'expected Quat')
    else if (Math.abs(Math.hypot(...(pl.rotation as number[])) - 1) > 1e-5) err(`${p}.rotation`, 'not a unit quaternion')
    if (!isObj(pl.flags) || typeof pl.flags.static !== 'boolean' || typeof pl.flags.big !== 'boolean' || typeof pl.flags.struct !== 'boolean') {
      err(`${p}.flags`, 'expected {static, big, struct} booleans')
    }
    for (const k of ['yaw', 'staticFlag', 'uid', 'region', 'group']) if (!isNum(pl[k])) err(`${p}.${k}`, 'expected a number')
    if (typeof pl.compound !== 'boolean' || typeof pl.inConvertedRegion !== 'boolean') err(p, 'bad compound/inConvertedRegion')
    if (pl.scale !== undefined && !(isNum(pl.scale) && pl.scale >= PLACEMENT_SCALE_MIN && pl.scale <= PLACEMENT_SCALE_MAX)) {
      err(`${p}.scale`, `expected a number in ${PLACEMENT_SCALE_MIN}..${PLACEMENT_SCALE_MAX}`)
    }
  })

  if (m.nav !== undefined) {
    const n = m.nav
    if (!isObj(n) || !isStr(n.file) || n.format !== 'SRNV' || !isNum(n.version) || !isNum(n.bytes) || n.space !== 'file' ||
      !Array.isArray(n.regions) || !n.regions.every(isNum) || !isNum(n.models) || !isNum(n.instances) ||
      !isNum(n.neighbourInstances) || !isNum(n.compoundInstances) || !isNum(n.links)) err('nav', 'bad nav entry')
  }
  if (m.spawn !== undefined) {
    const sp = m.spawn
    if (!isObj(sp) || !isNum(sp.x) || !isNum(sp.y) || !isNum(sp.z) || !isNum(sp.yaw) || !isStr(sp.source)) err('spawn', 'expected {x, y, z, yaw, source}')
  }

  if (m.displayName !== undefined && !isStr(m.displayName)) err('displayName', 'expected a string')
  validateStreamFields(m, regions, err)
  if (m.coast !== undefined) validateCoast(m.coast, err)
  if (m.town !== undefined) {
    const t = m.town
    const f = (v: unknown) => v === null || isRelPath(v)
    if (!isObj(t) || !f(t.file) || !f(t.dressing) || (t.file === null && t.dressing === null)) {
      err('town', 'expected {file, dressing}: relative paths (no ..) or null, not both null')
    }
  }

  if (!Array.isArray(m.warnings) || !m.warnings.every(isStr)) err('warnings', 'expected string[]')
  const rep = m.report
  if (!isObj(rep)) err('report', 'expected an object')
  else {
    for (const k of ['regions', 'placementRecords', 'placements', 'uniqueModels', 'modelsConverted', 'validatorErrors']) {
      if (!isNum(rep[k])) err(`report.${k}`, 'expected a number')
    }
    if (rep.placements !== placements.length) err('report.placements', 'does not match placements.length')
    if (!Array.isArray(rep.failedModels)) err('report.failedModels', 'expected an array')
    if (!isObj(rep.sizes) || !isNum(rep.sizes.totalBytes) || !isObj(rep.sizes.byCategory)) err('report.sizes', 'bad sizes')
    if (!isObj(rep.timeMs) || !isNum(rep.timeMs.total)) err('report.timeMs', 'bad timeMs')
    if (rep.coast !== undefined) {
      const pl = isObj(rep.coast) ? rep.coast.placements : undefined
      const refs = (v: unknown) => Array.isArray(v) && v.every(e => isObj(e) && isInt(e.region) && isInt(e.uid))
      if (!isObj(pl) || !refs(pl.dropped) || !refs(pl.resnapped) || !refs(pl.added)) {
        err('report.coast', 'expected {placements: {dropped, resnapped, added}}')
      }
    }
    if (rep.town !== undefined) {
      const tr = rep.town
      const refs = (v: unknown) => Array.isArray(v) && v.every(e => isObj(e) && isInt(e.region) && isInt(e.uid))
      const pl = isObj(tr) ? tr.placements : undefined
      if (!isObj(tr) || !isObj(pl) || !refs(pl.dropped) || !refs(pl.resnapped) || !refs(pl.added) || !isInt(tr.models) || !isInt(tr.clothModels) ||
        (tr.lampRows !== undefined && !isInt(tr.lampRows))) {
        err('report.town', 'expected {placements: {dropped, resnapped, added}, models, clothModels, lampRows?}')
      }
    }
    if (rep.edits !== undefined) {
      const er = rep.edits
      const refs = (v: unknown) => Array.isArray(v) && v.every(e => isObj(e) && isInt(e.region) && isInt(e.uid))
      const pl = isObj(er) ? er.placements : undefined
      if (!isObj(er) || !isObj(pl) || !refs(pl.dropped) || !refs(pl.resnapped) || !refs(pl.added) || !isInt(er.models) || !isInt(er.staticVariants) ||
        (er.footprintProblems !== undefined && !isInt(er.footprintProblems))) {
        err('report.edits', 'expected {placements: {dropped, resnapped, added}, models, staticVariants, footprintProblems?}')
      }
    }
    if (rep.trees !== undefined) {
      const tr = rep.trees
      if (!isObj(tr) || !isInt(tr.species) || !isInt(tr.swapped)) err('report.trees', 'expected {species, swapped}')
    }
    if (rep.remasterModels !== undefined) {
      const rm = rep.remasterModels
      if (!Array.isArray(rm) || !rm.every(r => isObj(r) && isStr(r.source) && isStr(r.glb) && isInt(r.bytes))) {
        err('report.remasterModels', 'expected [{source, glb, bytes}]')
      }
    }
  }
  return errors
}

/** manifest.coast (docs/COAST.md §8.1). */
function validateCoast(c: unknown, err: (path: string, what: string) => void): void {
  if (!isObj(c)) return err('coast', 'expected an object')
  if (!isNum(c.seaLevelM)) err('coast.seaLevelM', 'expected a number')
  const f = c.field
  if (!isObj(f) || !isRelPath(f.file) || !isNum(f.x0) || !isNum(f.z0) || !isNum(f.metresPerTexel) || f.metresPerTexel <= 0 ||
    !isInt(f.width) || !isInt(f.height) || f.width <= 0 || f.height <= 0) {
    err('coast.field', 'expected {file (relative, no ..), x0, z0, metresPerTexel > 0, width, height}')
  }
  if (!isStr(c.mapColor) || !/^#[0-9a-f]{6}$/i.test(c.mapColor)) err('coast.mapColor', "expected '#rrggbb'")
  if (!isStr(c.sourceHash) || !c.sourceHash) err('coast.sourceHash', 'expected a non-empty string')
}

/** A relative path inside the world folder: no leading '/', drive or backslash, and no '..' segment. */
const isRelPath = (v: unknown): v is string =>
  isStr(v) && v.length > 0 && !v.startsWith('/') && !v.includes('\\') && !/^[a-z]+:/i.test(v) && !v.split('/').includes('..')

const isInt = (v: unknown): v is number => Number.isInteger(v)

/** The additive `bounds`, `stream` and `places` fields (docs/FIELDS.md §3.9), when present. */
function validateStreamFields(m: Record<string, unknown>, regions: unknown[], err: (path: string, what: string) => void): void {
  const rects: Array<{ min: number[]; max: number[] }> = []
  const ids = new Set<number>()
  for (const r of regions) {
    if (!isObj(r)) continue
    if (isObj(r.bounds) && isVec(r.bounds.min, 3) && isVec(r.bounds.max, 3)) rects.push({ min: r.bounds.min as number[], max: r.bounds.max as number[] })
    if (isNum(r.x) && isNum(r.z)) ids.add((r.z << 8) | r.x)
  }
  const eps = 1e-6
  if (m.bounds !== undefined) {
    const b = m.bounds
    if (!isObj(b) || !isNum(b.minX) || !isNum(b.minZ) || !isNum(b.maxX) || !isNum(b.maxZ) || b.minX >= b.maxX || b.minZ >= b.maxZ) {
      err('bounds', 'expected {minX, minZ, maxX, maxZ} with min < max')
    } else if (!rects.length) err('bounds', 'no regions to lie inside')
    else {
      const minX = Math.min(...rects.map(r => r.min[0]!))
      const maxX = Math.max(...rects.map(r => r.max[0]!))
      const minZ = Math.min(...rects.map(r => r.min[2]!))
      const maxZ = Math.max(...rects.map(r => r.max[2]!))
      if (b.minX < minX - eps || b.maxX > maxX + eps || b.minZ < minZ - eps || b.maxZ > maxZ + eps) {
        err('bounds', 'not inside the union of the regions')
      }
    }
  }
  if (m.stream !== undefined) {
    const s = m.stream
    if (!isObj(s)) err('stream', 'expected an object')
    else {
      const p = s.playable
      if (!isObj(p) || !isInt(p.x0) || !isInt(p.x1) || !isInt(p.z0) || !isInt(p.z1) || p.x0 > p.x1 || p.z0 > p.z1) {
        err('stream.playable', 'expected integer {x0, x1, z0, z1} with x0 <= x1 and z0 <= z1')
      } else {
        for (let z = p.z0; z <= p.z1; z++) {
          for (let x = p.x0; x <= p.x1; x++) if (!ids.has((z << 8) | x)) err('stream.playable', `region ${x},${z} is not in regions`)
        }
      }
      const nr = s.navRegions
      if (!isObj(nr) || !isRelPath(nr.dir) || !isNum(nr.bytes)) err('stream.navRegions', 'expected {dir (relative, no ..), bytes}')
      const no = s.navObjects
      if (!isObj(no) || !isRelPath(no.file) || !isNum(no.bytes)) err('stream.navObjects', 'expected {file (relative, no ..), bytes}')
      const w = s.worldMap
      if (w !== null) {
        if (!isObj(w) || !isRelPath(w.file) || !isInt(w.pxPerRegion) || w.pxPerRegion <= 0 || !isInt(w.x0) || !isInt(w.x1) ||
          !isInt(w.z0) || !isInt(w.z1) || !isInt(w.width) || !isInt(w.height)) {
          err('stream.worldMap', 'expected null or {file, pxPerRegion, x0, x1, z0, z1, width, height}')
        } else if (w.width !== (w.x1 - w.x0 + 1) * w.pxPerRegion || w.height !== (w.z1 - w.z0 + 1) * w.pxPerRegion) {
          err('stream.worldMap', 'width/height do not match the region span')
        }
      }
      if (!isNum(s.loadRadiusM) || !isNum(s.unloadRadiusM) || s.loadRadiusM <= 0 || s.unloadRadiusM < s.loadRadiusM) {
        err('stream', 'expected 0 < loadRadiusM <= unloadRadiusM')
      }
    }
  }
  if (m.places !== undefined) {
    if (!Array.isArray(m.places)) err('places', 'expected an array')
    else {
      const seen = new Set<string>()
      m.places.forEach((pl: unknown, i: number) => {
        if (!isObj(pl) || !isStr(pl.name) || !/^[a-z0-9_-]{1,32}$/.test(pl.name) || !isNum(pl.x) || !isNum(pl.y) || !isNum(pl.z) ||
          !isStr(pl.source)) return err(`places[${i}]`, 'expected {name (/^[a-z0-9_-]{1,32}$/), x, y, z, source}')
        if (seen.has(pl.name)) err(`places[${i}]`, `duplicate name ${pl.name}`)
        seen.add(pl.name)
      })
    }
  }
}
