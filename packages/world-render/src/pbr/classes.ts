/**
 * Material classes (docs/RENDER.md §3.3, docs/WAVE_PLAN3.md D27): one table that gives every retail texture a class,
 * and every class its derived PBR defaults (roughness, metallic, normal strength) and wet response (porosity, wet
 * roughness, puddle eligibility). Also the six terrain surface classes the Classic terrain shader reads from the
 * layer-map alpha (docs/WEATHER.md §6.2) and the foliage model rule (WEATHER §6.4).
 *
 * Pure and environment-neutral: the texture pipeline (packages/texpipe, TP-0) imports `classify` from here by
 * relative path. Written by W9A-S; owned by RND-M afterwards (rule tuning, `content/render/material-overrides.json`).
 */

export const MATERIAL_CLASSES = [
  'water', 'metal', 'roof_tile', 'stone', 'wood', 'cloth', 'foliage', 'ground_soil', 'ground_grass', 'skin', 'default',
] as const
export type MaterialClass = (typeof MATERIAL_CLASSES)[number]

export interface MaterialClassParams {
  /** Roughness without an ORM map (the plugin adds ±0.1 × (0.5 − luma(albedo))). */
  roughness: number
  metallic: number
  /** Normal-map strength when a set has one. */
  normalStrength: number
  /** Wet darkening 0..1 (`albedo *= mix(1, 1 − 0.5 × porosity, w)`, RENDER §9.2). */
  porosity: number
  /** Roughness when soaked. */
  wetRoughness: number
  /** Puddle eligibility 0..1 (flat ground only; RENDER §9.3 classes, WEATHER §6.2 weights). */
  puddle: number
  /** Back-light translucency 0..1 (foliage, cloth, skin). */
  translucency: number
}

/** RENDER §3.3's table; `puddle` from RENDER §9.3 with WEATHER §6.2's weights (grass 0.35, soil 1, stone 0.9). */
export const MATERIAL_CLASS_PARAMS: Readonly<Record<MaterialClass, Readonly<MaterialClassParams>>> = {
  water: { roughness: 0.05, metallic: 0, normalStrength: 1, porosity: 0, wetRoughness: 0.05, puddle: 0, translucency: 0 },
  metal: { roughness: 0.35, metallic: 0.9, normalStrength: 1, porosity: 0, wetRoughness: 0.2, puddle: 0, translucency: 0 },
  roof_tile: { roughness: 0.55, metallic: 0, normalStrength: 1, porosity: 0.25, wetRoughness: 0.15, puddle: 0, translucency: 0 },
  stone: { roughness: 0.8, metallic: 0, normalStrength: 1, porosity: 0.35, wetRoughness: 0.25, puddle: 0.9, translucency: 0 },
  wood: { roughness: 0.7, metallic: 0, normalStrength: 0.8, porosity: 0.5, wetRoughness: 0.3, puddle: 0, translucency: 0 },
  cloth: { roughness: 0.85, metallic: 0, normalStrength: 0.6, porosity: 0.6, wetRoughness: 0.5, puddle: 0, translucency: 0.25 },
  foliage: { roughness: 0.6, metallic: 0, normalStrength: 0.6, porosity: 0.3, wetRoughness: 0.25, puddle: 0, translucency: 0.6 },
  ground_soil: { roughness: 0.9, metallic: 0, normalStrength: 1, porosity: 0.6, wetRoughness: 0.2, puddle: 1, translucency: 0 },
  ground_grass: { roughness: 0.85, metallic: 0, normalStrength: 0.8, porosity: 0.45, wetRoughness: 0.3, puddle: 0.35, translucency: 0 },
  skin: { roughness: 0.55, metallic: 0, normalStrength: 0.5, porosity: 0.1, wetRoughness: 0.35, puddle: 0, translucency: 0.3 },
  default: { roughness: 0.75, metallic: 0, normalStrength: 1, porosity: 0.4, wetRoughness: 0.3, puddle: 0, translucency: 0 },
}

/** Extra facts the caller may know about a texture; every field is optional. */
export interface ClassifyHints {
  /** tile2d type name (formats/tile2d.ts TILE2D_TYPES: Grass, Dirt, Stone, Water, ...) for terrain tiles. */
  tileType?: string
  /** The sidecar's glTF alpha mode. */
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'
  /** The BMT material has the env-map flag. */
  envMap?: boolean
  /** The BSR/mesh has dyVertex (cloth simulation). */
  dyVertex?: boolean
  /** The retail material name (characters: `*_face*`, `*_body*`, `*_hand*`). */
  materialName?: string
}

/** Lower-case, forward slashes (the same normalisation as TEXPIPE `keyOf`). */
function norm(key: string): string {
  return key.replace(/\\/g, '/').toLowerCase()
}

interface ClassRule {
  cls: MaterialClass
  /** Word rule on the file name (not the directories: `item/china/armor/` holds cloth armour). */
  name?: RegExp
  /** A rule on the hints and the whole normalised key. */
  test?: (hints: ClassifyHints, key: string, file: string) => boolean
}

/**
 * RENDER §3.3 in table order; the first rule that matches wins. RND-M additions, from the town's 40 most-used textures
 * (test/pbr-classes.test.ts): the retail names are often romanised Korean, so `pokpo` (폭포, waterfall) is water,
 * `dam` (담, wall), `floor` and `flooste` (floor stone) are stone, `gidun(g)` (기둥, pillar) and the truncated `pilla`
 * are wood.
 *
 * TP-0 question 2, `tre_bank_pilla` (62 placements, 32 in town): it is the ginkgo's trunk, an opaque bark texture, so
 * it is **wood**, not foliage (foliage's 0.6 translucency would make bark glow when back-lit). The general rule: a
 * `tre_*` texture drawn OPAQUE is the trunk (leaves and cards are alpha-tested), so it is wood (`tre_maple_pin`,
 * `tre_pine08_03` too).
 */
const RULES: readonly ClassRule[] = [
  { cls: 'water', name: /water|pokpo/ },
  { cls: 'metal', name: /metal|iron|bronze|gold|bell|sword|armor/, test: (h) => h.envMap === true },
  { cls: 'roof_tile', name: /roof|giwa|tile_/ },
  { cls: 'stone', name: /stone|rock|marble|brick|wall|stair|pave|statue|floor|flooste|(^|_)dam(\d|_|\.|$)/ },
  {
    cls: 'wood',
    name: /wood|board|pilla|gidun|trunk|bark|door|fence|bridge|boat/,
    test: (h, _k, file) => h.alphaMode === 'OPAQUE' && file.startsWith('tre_'),
  },
  { cls: 'cloth', name: /cloth|flag|banner|tent|curtain|sign/, test: (h) => h.dyVertex === true },
  { cls: 'foliage', name: /tre_|leaf|bush|grass|flower|plant/, test: (h, k) => h.alphaMode === 'MASK' && /(^|\/)nature\//.test(k) },
  { cls: 'ground_soil', name: /dust|soil|road/ },
  {
    cls: 'skin',
    test: (h, k, file) => /(^|\/)char\//.test(k) && /_(face|body|hand)/.test(`${file} ${norm(h.materialName ?? '')}`),
  },
]

/** tile2d type name → class (RENDER §3.3 "tile type" matches). */
const TILE_TYPE_CLASS: Readonly<Record<string, MaterialClass>> = {
  Water: 'water', DeepWater: 'water',
  Stone: 'stone', Ashfield: 'stone',
  Wood: 'wood',
  Dirt: 'ground_soil', Mud: 'ground_soil', Sand: 'ground_soil',
  Grass: 'ground_grass', LongGrass: 'ground_grass', Forest: 'ground_grass',
}

/**
 * The class of a texture. `key` is a retail texture path (`prim\mtrl\...\x.ddj`, any case and slash), a glb path with
 * `#image`, or a terrain key `tile2d:<stem>` (D36). Terrain tiles (a `tileType` hint or a `tile2d:` key) take the
 * terrain surface class first (D27: grass → ground_grass, dirt/mud/sand → ground_soil, stone → stone, water → water),
 * so the Classic and PBR terrain agree; everything else follows RENDER §3.3's first-match rules.
 */
export function classify(key: string, hints: ClassifyHints = {}): MaterialClass {
  const k = norm(key)
  const file = k.slice(Math.max(k.lastIndexOf('/'), k.lastIndexOf(':'), k.lastIndexOf('#')) + 1)
  if (hints.tileType !== undefined || k.startsWith('tile2d:')) {
    const surface = SURFACE_CLASS_MATERIAL[terrainSurfaceClass({ typeName: hints.tileType, file })]
    if (surface !== 'default') return surface
    const byType = hints.tileType ? TILE_TYPE_CLASS[hints.tileType] : undefined
    if (byType) return byType
  }
  for (const r of RULES) {
    if ((r.name && r.name.test(file)) || (r.test && r.test(hints, k, file))) return r.cls
  }
  return 'default'
}

/** The defaults of a class. */
export function classParams(cls: MaterialClass): Readonly<MaterialClassParams> {
  return MATERIAL_CLASS_PARAMS[cls]
}

export function isMaterialClass(v: unknown): v is MaterialClass {
  return typeof v === 'string' && (MATERIAL_CLASSES as readonly string[]).includes(v)
}

// ---- overrides (content/render/material-overrides.json, RENDER §3.3) --------------------------------------------

/**
 * The optional override file: a misclassified texture is fixed without code. Keys are retail texture paths (any case
 * and slash, like `SidecarMaterial.texture`) or `tile2d:<stem>`:
 *   { "format": "sro-material-overrides", "version": 1, "classes": { "prim/mtrl/.../x.ddj": "stone" } }
 * It is absent at first. The texture pipeline resolves its own overrides (content/texpipe/overrides.json) into the
 * `class` of each `sro-pbr` set; this file also covers textures that have no set.
 */
export const MATERIAL_OVERRIDES_FORMAT = 'sro-material-overrides'

export type ClassOverrides = ReadonlyMap<string, MaterialClass>

/** The override key of a path: lower case, forward slashes, no leading `./` or `/` (TEXPIPE `keyOf`). */
export function overrideKey(path: string): string {
  return norm(path.trim()).replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '')
}

/** Parses the override file; null when it is not one. Bad entries are skipped with a warning. */
export function parseClassOverrides(raw: unknown): { overrides: Map<string, MaterialClass>; warnings: string[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.format !== MATERIAL_OVERRIDES_FORMAT || r.version !== 1) return null
  const out = { overrides: new Map<string, MaterialClass>(), warnings: [] as string[] }
  const classes = r.classes
  if (!classes || typeof classes !== 'object' || Array.isArray(classes)) return out
  for (const [key, cls] of Object.entries(classes as Record<string, unknown>)) {
    if (!key.trim() || key.startsWith('$')) continue
    if (!isMaterialClass(cls)) out.warnings.push(`${key}: unknown class ${JSON.stringify(cls)}`)
    else out.overrides.set(overrideKey(key), cls)
  }
  return out
}

/**
 * PLAZA-RAIN: classes the code knows better than the built sets (the texture pipeline baked `default` into them, and
 * the override file is not shipped): the Jangan plaza's paving, `cj_jang_gate07` (a "gate" texture by name, the
 * flagstones of the plaza and the gate squares by use), is stone, so it darkens, glosses and pools in the rain like the
 * stone fields (puddle weight 0.9) instead of the `default` class's 0 (no puddles, a 0.75 film).
 */
export const BUILTIN_CLASS_OVERRIDES: ClassOverrides = new Map<string, MaterialClass>([
  ['prim/mtrl/bldg/china/jangan01/cj_jang_gate07.ddj', 'stone'],
])

/** `classify` with the override file, the built-in overrides and a set's own resolved class first. */
export function resolveClass(key: string, hints: ClassifyHints = {}, overrides?: ClassOverrides | null, setClass?: MaterialClass | null): MaterialClass {
  const k = overrideKey(key)
  return overrides?.get(k) ?? BUILTIN_CLASS_OVERRIDES.get(k) ?? setClass ?? classify(key, hints)
}

// ---- terrain surface classes (Classic terrain shader, layer-map alpha) ------------------------------------------

/** WEATHER §6.2 surface classes; the layer map's alpha is `128 + class` (+ NO_ANTI_TILE; terrain.ts), the shader reads it back. */
export const TERRAIN_SURFACE = { generic: 0, grass: 1, dirt: 2, sand: 3, stone: 4, water: 5 } as const
export type TerrainSurfaceClass = (typeof TERRAIN_SURFACE)[keyof typeof TERRAIN_SURFACE]
export const TERRAIN_SURFACE_COUNT = 6

/** Per surface class: porosity (darkening), gloss when wet, puddle weight (WEATHER §6.2), index = class. */
export const TERRAIN_SURFACE_PARAMS: readonly Readonly<{ porosity: number; gloss: number; puddle: number }>[] = [
  { porosity: 0.6, gloss: 0.5, puddle: 0.5 },
  { porosity: 0.55, gloss: 0.35, puddle: 0.35 },
  { porosity: 0.8, gloss: 0.6, puddle: 1 },
  { porosity: 0.9, gloss: 0.3, puddle: 0.15 },
  { porosity: 0.3, gloss: 1, puddle: 0.9 },
  { porosity: 0, gloss: 0, puddle: 0 },
]

/** Surface class → material class (D27; sand keeps its own porosity 0.9 through TERRAIN_SURFACE_PARAMS). */
export const SURFACE_CLASS_MATERIAL: readonly MaterialClass[] = [
  'default', 'ground_grass', 'ground_soil', 'ground_soil', 'stone', 'water',
]

const STONE_NAME = /marble|stone|rock|road|brick|pave/i
/** Ground names that beat a Water/DeepWater tile type (see terrainSurfaceClass). */
const SOIL_NAME = /dust|mud|swmp|swamp|soil|earth/i

/**
 * The surface class of a terrain tile from its tile2d type and file name (names win: c_marble_jang is typed Dirt).
 *
 * TP-0 question 1, the hero tile `c_dust_swmp_06` (7.2% of the fields): tile2d types it Water, but the texture is mossy
 * swamp mud with stones (checked by eye), drawn above the water plane; the type is the footstep class (wading), not
 * the look. Water is the separate water mesh. So a ground name (`dust|mud|swmp|soil|earth`) beats the Water type:
 * the swamp tiles are dirt (ground_soil), and darken and pool in rain instead of being a 0.05-roughness mirror that
 * never gets wet. A `water` name (oaho_water_*) stays water.
 */
export function terrainSurfaceClass(tile: { typeName?: string; file?: string; source?: string }): TerrainSurfaceClass {
  const name = `${tile.source ?? ''} ${tile.file ?? ''}`
  const type = tile.typeName ?? ''
  if (/water/i.test(name)) return TERRAIN_SURFACE.water
  if ((type === 'Water' || type === 'DeepWater') && SOIL_NAME.test(name)) return TERRAIN_SURFACE.dirt
  if (type === 'Water' || type === 'DeepWater') return TERRAIN_SURFACE.water
  if (type === 'Stone' || STONE_NAME.test(name)) return TERRAIN_SURFACE.stone
  if (type === 'Grass' || type === 'LongGrass' || type === 'Forest') return TERRAIN_SURFACE.grass
  if (type === 'Dirt' || type === 'Mud') return TERRAIN_SURFACE.dirt
  if (type === 'Sand' || type === 'Ashfield') return TERRAIN_SURFACE.sand
  return TERRAIN_SURFACE.generic
}

/**
 * TERRAIN_TEX F5 (TT-Q): the no-anti-tile bit of the layer-map alpha. A rotated second tap smears a regular joint
 * grid, so paving opts out of anti-tiling; the class table cannot carry it (paving shares `stone` with the rock and
 * the stone-named field soils). Every reader masks the class with SURFACE_CLASS_MASK (`& 63`).
 */
export const NO_ANTI_TILE = 64
export const SURFACE_CLASS_MASK = 63

/** Tile names that opt out of anti-tiling (TERRAIN_TEX §4.3: the paving, `c_marble_jang_*`). */
const NO_ANTI_TILE_NAME = /marble|pave|brick/i
/**
 * Paving whose name says nothing of it (H-12 TEL-2): the World Editor's palette files them under "Road and paving"
 * (flagstones with a joint grid, crazy paving, slabs set in dirt), so they opt out like the named paving.
 */
export const NO_ANTI_TILE_STEMS: ReadonlySet<string> = new Set(['alex_stone02', 'ruin_takl_dest_05', 'wc_dust_don_14', 'wc_dust_don_15'])

const stemOf = (name: string | undefined) => (name ?? '').split(/[\\/]/).pop()!.replace(/\.[a-z0-9]+$/i, '').toLowerCase()

/** True when a terrain tile (its file or source name) opts out of anti-tiling. */
export function terrainNoAntiTile(tile: { file?: string; source?: string }): boolean {
  return NO_ANTI_TILE_NAME.test(`${tile.source ?? ''} ${tile.file ?? ''}`) || NO_ANTI_TILE_STEMS.has(stemOf(tile.source)) || NO_ANTI_TILE_STEMS.has(stemOf(tile.file))
}

/**
 * Layer-map alpha byte for a surface class: `128 + class`, + 64 for a no-anti-tile tile (still ≥ 128, so the shader's
 * `t.a < 0.5` "no layer" test is unchanged, and ≤ 255).
 */
export function surfaceAlpha(cls: number, noAntiTile = false): number {
  return 128 + (cls & SURFACE_CLASS_MASK) + (noAntiTile ? NO_ANTI_TILE : 0)
}

/** The layer-map alpha byte of a manifest tile (terrain.ts layerData: the class and the no-anti-tile bit). */
export function terrainSurfaceAlpha(tile: { typeName?: string; file?: string; source?: string }): number {
  return surfaceAlpha(terrainSurfaceClass(tile), terrainNoAntiTile(tile))
}

/** The class back from a sampled alpha 0..1 (the shader's `i32(t.a × 255 + 0.5) & 63`). */
export function surfaceFromAlpha(a: number): number {
  return Math.round(a * 255) & SURFACE_CLASS_MASK
}

/** The no-anti-tile bit back from a sampled alpha 0..1 (the plugin's `(i32(t.a × 255 + 0.5) & 64) != 0`). */
export function noAntiTileFromAlpha(a: number): boolean {
  return (Math.round(a * 255) & NO_ANTI_TILE) !== 0
}

// ---- foliage models ---------------------------------------------------------------------------------------------

/** WEATHER §6.4 with the `\d*` fix (Dunhuang `tree2`/`tree3`); accepts either slash. */
const FOLIAGE_MODEL = /[\\/]nature[\\/](common|china[\\/][^\\/]+)[\\/](tree\d*|grass|flower|reed)[\\/]/i

/** True when a world model (its manifest `source`, e.g. `res\nature\china\jangan\tree\...`) is foliage. */
export function isFoliageModel(source: string): boolean {
  return FOLIAGE_MODEL.test(source)
}
