/**
 * The texture pipeline's build index, `work/out/pbr/index.json` (format 'sro-pbr', version 1; docs/TEXPIPE.md §6.2
 * with docs/WAVE_PLAN3.md D35–D37), and the key rules every lane shares.
 *
 * Environment-neutral (no node:* imports): the runtime loader (world-render `pbr/maps.ts`, RND-M) imports these types,
 * `keyOf`, `keyPath` and `validatePbrIndex` through a relative path, as it does `convert/src/world/format.ts`.
 *
 * Keys (D35, D36):
 *   - a model texture is keyed by its retail texture path (`SidecarMaterial.texture`), lower case with forward
 *     slashes: `prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj`. The path is unique and shared by every glb that
 *     uses it; glTF image names are not (they collide inside glbs);
 *   - a terrain tile is `tile2d:<stem>`, stem = the lower-case retail tile file stem (`tile2d:c_grass_fld_03`), which
 *     is stable across world exports (the manifest `tiles[].id` is per export);
 *   - a generated replacement is `gen:<name>` and names the set it replaces in `replaces`.
 *
 * Files (TEXPIPE §6.1): `work/out/pbr/<keyPath>/<map>@<tier>.<ext>`, served under `/out-opt/pbr/` unchanged.
 *   <keyPath> = the key with ':' → '/', lower case, '.ddj' removed (`tile2d/c_grass_fld_03`)
 *   <map>     = v1 WebP planes albedo | nx | ny | ao | rough | metal | height; v2 KTX2 albedo | normal | ormh
 *   <tier>    = the long edge in pixels: the retail size, 1024, 2048 (only those ≤ the 4× master)
 *
 * Map packing (D37, "ORMH everywhere"): the runtime packs the v1 planes (and KTX2 v2 ships) one RGBA texture with
 * R = ambient occlusion, G = roughness, B = metallic, A = height. Objects and actors bind it as Babylon's
 * `metallicTexture` with `useAmbientOcclusionFromMetallicTextureRed`, `useRoughnessFromMetallicTextureGreen` and
 * `useMetallnessFromMetallicTextureBlue`, and read height from A in the plugin; the terrain arrays are `albedo`,
 * `normal` (RG used) and `ormh`. Normal planes are linear bytes with 128 = 0 (`z = sqrt(1 - x² - y²)`).
 */
import { MATERIAL_CLASSES, type MaterialClass } from '../../world-render/src/pbr/classes.ts'

export const PBR_INDEX_FORMAT = 'sro-pbr'
export const PBR_INDEX_VERSION = 1
/** Where the index lives, relative to the output root (work/out, served as /out-opt/). */
export const PBR_INDEX_FILE = 'pbr/index.json'

export type AlphaKind = 'none' | 'cutout' | 'blend' | 'specmask'
export const ALPHA_KINDS: readonly AlphaKind[] = ['none', 'cutout', 'blend', 'specmask']

/** Review status: `auto` = not reviewed yet, `retail` = keep the retail texture, `replaced` = a `gen:` set wins. */
export type PbrStatus = 'auto' | 'ok' | 'albedo-only' | 'retail' | 'replaced'
export const PBR_STATUSES: readonly PbrStatus[] = ['auto', 'ok', 'albedo-only', 'retail', 'replaced']

export type PbrSource = 'local' | 'meshy' | 'generated'
export const PBR_SOURCES: readonly PbrSource[] = ['local', 'meshy', 'generated']

/**
 * DT-2, the albedo route of a set (the master TP-P derives from; docs/TEXPIPE.md §3.4a):
 *   `gan`    TP-U's Real-ESRGAN master (the default);
 *   `sdxl`   the detail stage's SDXL + ControlNet-Tile result on top of the GAN master (detail/run.ts), UV-gated;
 *   `retail` no AI at all: a Lanczos3 ×4 of the retail pixels (for art the models misread).
 */
export const DETAIL_ROUTES = ['sdxl', 'gan', 'retail'] as const
export type DetailRoute = (typeof DETAIL_ROUTES)[number]

/** The detail stage's calibrated parameter sets (work/tmp/detail/bakeoff/REPORT.md §4–§5, detail/profiles.ts). */
export const DETAIL_PROFILES = ['terrain', 'world', 'body', 'hair', 'equipment'] as const
export type DetailProfileName = (typeof DETAIL_PROFILES)[number]

/** The '2x' tier's cap: min(2 × the retail long edge, 1024) is High's albedo tier (TEXPIPE §6.4). */
export const TIER_2X_CAP = 1024

/** v1 per-tier planes (WebP). */
export const PBR_PLANES = ['albedo', 'nx', 'ny', 'ao', 'rough', 'metal', 'height'] as const
export type PbrPlane = (typeof PBR_PLANES)[number]
/** v2 single files (KTX2). */
export const PBR_FILES = ['albedo', 'normal', 'ormh', 'emissive'] as const
export type PbrFileMap = (typeof PBR_FILES)[number]

/** D37: channel index of each term in the packed ORMH texture (R, G, B, A). */
export const ORMH = { ao: 0, rough: 1, metal: 2, height: 3 } as const
export type OrmhTerm = keyof typeof ORMH
/** The same order as a list: `ORMH_ORDER[ORMH.rough] === 'rough'`. */
export const ORMH_ORDER: readonly OrmhTerm[] = ['ao', 'rough', 'metal', 'height']
/** The Babylon `PBRMaterial` flags that read ORMH as its metallic texture (D37); height (A) is read by the plugin. */
export const ORMH_BABYLON_FLAGS = [
  'useAmbientOcclusionFromMetallicTextureRed',
  'useRoughnessFromMetallicTextureGreen',
  'useMetallnessFromMetallicTextureBlue',
] as const

/** v1 normal planes: byte = 128 + 127 x (so 128 is 0, 1 is -1, 255 is +1). */
export const NORMAL_PLANE_ZERO = 128
export const NORMAL_PLANE_SCALE = 127

export function encodeNormalComponent(v: number): number {
  return Math.min(255, Math.max(1, Math.round(NORMAL_PLANE_ZERO + NORMAL_PLANE_SCALE * v)))
}

export function decodeNormalComponent(byte: number): number {
  return (byte - NORMAL_PLANE_ZERO) / NORMAL_PLANE_SCALE
}

/** z of a unit tangent-space normal from its x and y (0 when x² + y² ≥ 1). */
export function normalZ(x: number, y: number): number {
  return Math.sqrt(Math.max(0, 1 - x * x - y * y))
}

export interface PbrIndex {
  format: typeof PBR_INDEX_FORMAT
  version: typeof PBR_INDEX_VERSION
  /** Provenance: pipeline revision (git hash or tag), upscaler name, ISO build time. */
  pipeline: { rev: string; upscaler: string; createdAt: string }
  /** key → set; every set's `key` equals its record key. */
  sets: Record<string, PbrSet>
}

export interface PbrSet {
  /** `prim/mtrl/.../x.ddj` | `tile2d:<stem>` | `gen:<name>` (see keyOf, tileKey). */
  key: string
  /** Albedo size of the largest tier [w, h]. */
  size: [number, number]
  /** RENDER §3.3 class, resolved with overrides. */
  class: MaterialClass
  /** v2 (KTX2) single files, relative to the index. */
  albedo?: string
  normal?: string
  ormh?: string
  emissive?: string
  /** The albedo had its painted lighting removed (the renderer lowers direct light for sets without it). */
  delit?: boolean
  /** Tiles: retail periods covered by one texture (1; replacements may be 2). */
  uvScale?: number
  /** '<long edge>' → the files of that tier ('256', '1024', '2048'). */
  tiers: Record<string, PbrTier>
  alpha: AlphaKind
  /** Axes the mesh UVs repeat along [U, V] (tiles: both). */
  wrap: [boolean, boolean]
  status: PbrStatus
  /** Hero set (TEXPIPE §1.3): full maps on High. */
  hero: boolean
  /** Review overrides. */
  params?: { normalStrength?: number; roughness?: number; porosity?: number; metallic?: number }
  /** gen: sets only: the key of the retail set this replaces. */
  replaces?: string
  /** Provenance of the maps (local = this pipeline). */
  source?: PbrSource
  /** DT-2: which albedo master the maps were derived from (absent = `gan`). */
  detail?: DetailRoute
  /**
   * The key in `tiers` of the '2x' tier: min(2 × the retail long edge, 1024) (TIER_2X_CAP), High's albedo tier
   * (TEXPIPE §6.4). Optional (format version 1): a reader without it takes the largest tier ≤ 1024.
   */
  tier2x?: string
  /**
   * Tiles only (TERRAIN_TEX §5.2 item 4, WAVE_PLAN8 D7): the tile's share of the terrain vertices of the export's
   * non-synthetic regions, 0..1 (the inventory's `cover.all`). Optional (format version 1): the runtime's set range
   * (TT-R) reserves its last layers for hero tiles at or above the median cover; a reader without it ignores it.
   */
  cover?: number
}

export interface PbrTier {
  size: [number, number]
  /** RGB(A) sRGB, lossy q90; alpha lossless for cutout/blend, none otherwise. */
  albedo: string
  /** v1 normal planes, linear, 128 = 0. */
  nx?: string
  ny?: string
  /** v1 planes, linear, half the tier size. */
  ao?: string
  rough?: string
  metal?: string
  /** v1 plane, linear, full tier size. */
  height?: string
  /** Sum of the tier's files in bytes (for the budget HUD). */
  bytes: number
}

/**
 * `content/texpipe/overrides.json`: the committed per-texture corrections of the review (TEXPIPE §3.8). The
 * inventory applies `class`, `hero`, `alpha` and `wrap`; the later stages read `status` and `params`.
 */
export const OVERRIDES_FORMAT = 'sro-texpipe-overrides'
export const OVERRIDES_VERSION = 1

export interface TexpipeOverrides {
  format: typeof OVERRIDES_FORMAT
  version: typeof OVERRIDES_VERSION
  /** key (keyOf / tileKey form) → correction. */
  sets: Record<string, TexpipeOverride>
  /** Per material class defaults (a set's own field wins): today only the DT-2 albedo route. */
  classes?: Partial<Record<MaterialClass, ClassOverride>>
}

export interface ClassOverride {
  /** DT-2: the albedo route of every set of this class without its own `detail`. */
  detail?: DetailRoute
  note?: string
}

/** DT-2: per-texture SDXL settings (each defaults to the profile's calibrated value, detail/profiles.ts). */
export interface SdxlOverride {
  profile?: DetailProfileName
  /** Replaces the profile's positive prompt (the style suffix is kept). */
  prompt?: string
  denoise?: number
  /** Wrap axes (terrain): the denoise of the half-offset seam band. */
  seamDenoise?: number
  /** ControlNet-Tile strength. */
  cn?: number
  cfg?: number
  steps?: number
  sampler?: string
  /** Colour-fix radius in source texels (low frequencies below it come from the retail texture). */
  cfix?: number
  seed?: number
  /** Bodies: the face pass over the `*_face` mesh's islands whose centroid lies in this UV rectangle, at this denoise. */
  face?: { uv: [number, number, number, number]; denoise?: number } | null
}

export interface TexpipeOverride {
  class?: MaterialClass
  hero?: boolean
  alpha?: AlphaKind
  wrap?: [boolean, boolean]
  status?: PbrStatus
  params?: PbrSet['params']
  /** Free text for the reviewer. */
  note?: string
  /** TP-U: the upscale model and the AI/Lanczos mix for this texture (TEXPIPE §3.4). */
  upscale?: UpscaleOverride
  /** TP-P: the derivation knobs of this texture (TEXPIPE §3.5–3.7, DETAIL L3). */
  pbr?: PbrDeriveOverride
  /** DT-2: the albedo route (wins over `classes[class].detail`; default `gan`). */
  detail?: DetailRoute
  /** DT-2: SDXL settings when the route is `sdxl`. */
  sdxl?: SdxlOverride
}

/**
 * TP-P material-mask classes (DETAIL L3), the vocabulary of a set's class mask: index = the class id stored in the
 * mask (255 = no class, a gutter or a transparent texel). `wood` and `jade` are never assigned by the clustering, only
 * by a review relabel or paint (the Copper Sword atlas: sword_01's wooden grip, sword_02's jade blade). `jade` is
 * polished stone (jade, gem and stone inlays): smooth, dielectric, no weave. New classes are appended so the stored
 * ids stay valid. The runtime detail plugin (DT-4) reads the same order.
 */
export const MASK_CLASSES = ['cloth', 'leather', 'metal', 'gold', 'skin', 'hair', 'wood', 'jade'] as const
export type MaskClass = (typeof MASK_CLASSES)[number]
export const MASK_NONE = 255

export interface PbrDeriveOverride {
  /** De-light strength k, 0..1 (0 = keep the painted light; TEXPIPE §3.5). */
  delight?: number
  /** × the profile's normal strength, 0..4. */
  normalScale?: number
  /** × the profile's AO strength, 0..4. */
  aoScale?: number
  /** Light features are recessed (white mortar, pale cracks): height = 1 − height (TEXPIPE §3.6). */
  invertHeight?: boolean
  /** × the de-lit albedo in linear light, 0..2 (COAST §7.2: the wet-sand remaster of tile 70 is × 0.55–0.65). */
  albedoGain?: number
  /**
   * × the albedo per channel [r, g, b] in linear light, each 0..2, after `albedoGain` (P-LOOK: the pale dry beach sand
   * warmed to a golden sand; pbr/grain.ts).
   */
  albedoTint?: [number, number, number]
  /** A tileable sand grain multiplied into the albedo, 0..2 (0 = none, 1 = the tuned sand; pbr/grain.ts). */
  grain?: number
  /** The base roughness of the derived roughness plane, 0..1, instead of the class's (COAST §7.2: wet sand 0.25–0.35). */
  roughness?: number
  /** Tileable sand-ripple marks blended into the height, 0..1 (0 = none; COAST §7.2 wet sand; pbr/ripples.ts). */
  ripples?: number
  /** × the baked detail amplitude, 0..2 (0 = no baked detail; DETAIL L3/L4). */
  detail?: number
  /** The classes the material-mask clustering may assign (DETAIL L3). */
  maskAllowed?: MaskClass[]
  /** Review fixes of the clustering: cluster index ('0'..'15') → class, or 'fill' (painted shadow, taken from around). */
  maskRelabel?: Record<string, MaskClass | 'fill'>
  /**
   * Review paint, applied after the relabels (in order): inside the UV rectangle [u0, v0, u1, v1] (0..1, v down as in
   * the image), the island texels (only those of the listed clusters, when `clusters` is given) take `class`. For a
   * cluster that covers two materials on different parts of an atlas (one brown cluster = sword_01's wooden grip and
   * sword_03's cord wrap), or a class the fill rule cannot reach (dark hair filled as skin).
   */
  maskPaint?: MaskPaint[]
}

export interface MaskPaint {
  uv: [number, number, number, number]
  class: MaskClass
  clusters?: number[]
  /** Free text for the reviewer (what this paints). */
  note?: string
}

const PBR_OVERRIDE_NUMBERS: Record<string, [number, number]> = {
  delight: [0, 1], normalScale: [0, 4], aoScale: [0, 4], detail: [0, 2], albedoGain: [0, 2], roughness: [0, 1], ripples: [0, 1], grain: [0, 2],
}

function validatePbrOverride(at: string, v: unknown, err: (path: string, what: string) => void): void {
  if (!isObj(v)) return err(at, 'expected an object')
  for (const [k, n] of Object.entries(v)) {
    const range = PBR_OVERRIDE_NUMBERS[k]
    if (range) {
      if (!isNum(n) || n < range[0] || n > range[1]) err(`${at}.${k}`, `expected a number in ${range[0]}..${range[1]}`)
    } else if (k === 'albedoTint') {
      if (!(Array.isArray(n) && n.length === 3 && n.every(c => isNum(c) && c >= 0 && c <= 2))) err(`${at}.${k}`, 'expected [r, g, b], each a number in 0..2')
    } else if (k === 'invertHeight') {
      if (typeof n !== 'boolean') err(`${at}.${k}`, 'expected a boolean')
    } else if (k === 'maskAllowed') {
      if (!Array.isArray(n) || !n.length || !n.every(c => (MASK_CLASSES as readonly unknown[]).includes(c))) err(`${at}.${k}`, `expected a list of ${MASK_CLASSES.join(', ')}`)
    } else if (k === 'maskRelabel') {
      if (!isObj(n)) err(`${at}.${k}`, 'expected an object')
      else for (const [c, cls] of Object.entries(n)) {
        if (!/^(\d|1[0-5])$/.test(c)) err(`${at}.${k}.${c}`, 'expected a cluster index 0..15')
        else if (cls !== 'fill' && !(MASK_CLASSES as readonly unknown[]).includes(cls)) err(`${at}.${k}.${c}`, `expected fill or one of ${MASK_CLASSES.join(', ')}`)
      }
    } else if (k === 'maskPaint') {
      if (!Array.isArray(n)) err(`${at}.${k}`, 'expected a list')
      else n.forEach((e, i) => validateMaskPaint(`${at}.${k}[${i}]`, e, err))
    } else err(`${at}.${k}`, 'unknown field')
  }
}

function validateMaskPaint(at: string, e: unknown, err: (path: string, what: string) => void): void {
  if (!isObj(e)) return err(at, 'expected an object')
  for (const k of Object.keys(e)) if (!['uv', 'class', 'clusters', 'note'].includes(k)) err(`${at}.${k}`, 'unknown field')
  const uv = e.uv
  if (!(Array.isArray(uv) && uv.length === 4 && uv.every(v => isNum(v) && v >= 0 && v <= 1) && uv[0] < uv[2] && uv[1] < uv[3])) {
    err(`${at}.uv`, 'expected [u0, v0, u1, v1] in 0..1 with u0 < u1 and v0 < v1')
  }
  if (!(MASK_CLASSES as readonly unknown[]).includes(e.class)) err(`${at}.class`, `expected one of ${MASK_CLASSES.join(', ')}`)
  if (e.clusters !== undefined && !(Array.isArray(e.clusters) && e.clusters.length && e.clusters.every(c => Number.isInteger(c) && c >= 0 && c <= 15))) {
    err(`${at}.clusters`, 'expected a list of cluster indices 0..15')
  }
  if (e.note !== undefined && typeof e.note !== 'string') err(`${at}.note`, 'expected a string')
}

/** The upscalers TP-U can run: Real-ESRGAN x4plus (natural surfaces), x4plus-anime (hair, flat paint), Lanczos3 only. */
export const UPSCALE_MODELS = ['realesrgan-x4plus', 'realesrgan-x4plus-anime', 'lanczos'] as const
export type UpscaleModel = (typeof UPSCALE_MODELS)[number]

export interface UpscaleOverride {
  model?: UpscaleModel
  /** AI share of the result, 0..1 (the rest is Lanczos3). */
  aiMix?: number
}

// ---- keys ---------------------------------------------------------------------------------------------------------

const KEY_PREFIXES = ['tile2d:', 'gen:'] as const

/**
 * The index key of a retail texture path: lower case, `\` → `/`, repeated slashes and a leading `./` or `/` removed.
 * `keyOf('prim\\mtrl\\item\\china\\weapon\\sword1_2_3.ddj')` → `prim/mtrl/item/china/weapon/sword1_2_3.ddj`.
 * Keys that already carry a `tile2d:` or `gen:` prefix are only lower-cased.
 */
export function keyOf(path: string): string {
  const lower = path.trim().toLowerCase()
  if (KEY_PREFIXES.some(p => lower.startsWith(p))) return lower
  return lower.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '')
}

/** The lower-case file stem of a path: directories and the last extension removed. */
export function fileStem(path: string): string {
  const file = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = file.lastIndexOf('.')
  return (dot > 0 ? file.slice(0, dot) : file).toLowerCase()
}

/** The key of a terrain tile from its retail source (`c_grass_fld_03.ddj`), manifest file or stem (D36). */
export function tileKey(sourceOrStem: string): string {
  return `tile2d:${fileStem(sourceOrStem)}`
}

/** A path character that needs no escaping in a file name or a URL. */
const SAFE_CHAR = /[a-z0-9_\-./]/

/**
 * The folder of a key's files under pbr/: ':' → '/', lower case, '.ddj' removed. A few retail paths hold a space
 * (`tre_bam04_01 .ddj`) or Hangul (`나무01.ddj`), so every other character becomes `~<hex code point>~`
 * (`tre_bam04_01~20~`): URL- and file-safe, and still one folder per key (`~` itself is escaped).
 */
export function keyPath(key: string): string {
  const path = keyOf(key).replace(':', '/').replace(/\.ddj$/, '')
  let out = ''
  for (const ch of path) out += SAFE_CHAR.test(ch) ? ch : `~${ch.codePointAt(0)!.toString(16)}~`
  return out
}

/** A set's file of one map and tier, relative to the index: `<keyPath>/<map>@<tier>.<ext>`. */
export function pbrFile(key: string, map: PbrPlane | PbrFileMap, tier: number | string, ext = 'webp'): string {
  return `${keyPath(key)}/${map}@${tier}.${ext}`
}

/**
 * Null when `key` is a normalised key; otherwise why not. Retail paths are kept as they are (a space or Hangul is
 * allowed, keyPath escapes them); control characters, `:` outside the prefix, `#`, `?`, `%`, `~` and empty, `.` or
 * `..` segments are not.
 */
export function checkKey(key: string): string | null {
  if (key !== keyOf(key)) return 'not normalised (keyOf)'
  const prefix = KEY_PREFIXES.find(p => key.startsWith(p))
  const rest = prefix ? key.slice(prefix.length) : key
  if (!rest) return 'empty'
  const segs = rest.split('/')
  if (prefix === 'tile2d:' && segs.length !== 1) return 'tile2d key must be a bare stem'
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || /[\u0000-\u001f:#?%~]/.test(s) || s !== s.trim()) return `bad path segment ${JSON.stringify(s)}`
  }
  return null
}

// ---- validation -----------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isSize = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every(n => Number.isInteger(n) && (n as number) > 0)
/** A relative file path inside pbr/: no scheme, no leading slash, no `..`. */
const isRelFile = (v: unknown): v is string =>
  isStr(v) && !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith('/') && !v.includes('\\') && !v.split('/').includes('..')

const TIER_FILES = ['albedo', 'nx', 'ny', 'ao', 'rough', 'metal', 'height'] as const
const SET_FILES = ['albedo', 'normal', 'ormh', 'emissive'] as const
const PARAMS = ['normalStrength', 'roughness', 'porosity', 'metallic'] as const

/** Every problem of an index as `path: what` (empty = valid). */
export function validatePbrIndex(index: unknown): string[] {
  const errors: string[] = []
  const err = (path: string, what: string) => {
    if (errors.length < 200) errors.push(`${path}: ${what}`)
  }
  if (!isObj(index)) return ['index: not an object']
  if (index.format !== PBR_INDEX_FORMAT) err('format', `expected ${PBR_INDEX_FORMAT}`)
  if (index.version !== PBR_INDEX_VERSION) err('version', `expected ${PBR_INDEX_VERSION}`)
  const p = index.pipeline
  if (!isObj(p) || !isStr(p.rev) || !isStr(p.upscaler) || !isStr(p.createdAt)) err('pipeline', 'expected {rev, upscaler, createdAt}')
  if (!isObj(index.sets)) {
    err('sets', 'expected an object')
    return errors
  }
  for (const [key, set] of Object.entries(index.sets)) validateSet(key, set, index.sets, err)
  return errors
}

/** Every problem of an overrides file as `path: what` (empty = valid). */
export function validateOverrides(o: unknown): string[] {
  const errors: string[] = []
  const err = (path: string, what: string) => {
    if (errors.length < 200) errors.push(`${path}: ${what}`)
  }
  if (!isObj(o)) return ['overrides: not an object']
  if (o.format !== OVERRIDES_FORMAT) err('format', `expected ${OVERRIDES_FORMAT}`)
  if (o.version !== OVERRIDES_VERSION) err('version', `expected ${OVERRIDES_VERSION}`)
  if (!isObj(o.sets)) {
    err('sets', 'expected an object')
    return errors
  }
  for (const [key, v] of Object.entries(o.sets)) {
    const at = `sets[${JSON.stringify(key)}]`
    const bad = checkKey(key)
    if (bad) err(at, `bad key (${bad})`)
    if (!isObj(v)) {
      err(at, 'expected an object')
      continue
    }
    for (const k of Object.keys(v)) {
      if (!['class', 'hero', 'alpha', 'wrap', 'status', 'params', 'note', 'upscale', 'pbr', 'detail', 'sdxl'].includes(k)) err(`${at}.${k}`, 'unknown field')
    }
    if (v.detail !== undefined && !(DETAIL_ROUTES as readonly unknown[]).includes(v.detail)) err(`${at}.detail`, `expected one of ${DETAIL_ROUTES.join(', ')}`)
    if (v.sdxl !== undefined) validateSdxlOverride(`${at}.sdxl`, v.sdxl, err)
    if (v.class !== undefined && !(MATERIAL_CLASSES as readonly unknown[]).includes(v.class)) err(`${at}.class`, 'unknown class')
    if (v.hero !== undefined && typeof v.hero !== 'boolean') err(`${at}.hero`, 'expected a boolean')
    if (v.alpha !== undefined && !(ALPHA_KINDS as readonly unknown[]).includes(v.alpha)) err(`${at}.alpha`, 'unknown alpha kind')
    if (v.wrap !== undefined && !(Array.isArray(v.wrap) && v.wrap.length === 2 && v.wrap.every(b => typeof b === 'boolean'))) {
      err(`${at}.wrap`, 'expected [boolean, boolean]')
    }
    if (v.status !== undefined && !(PBR_STATUSES as readonly unknown[]).includes(v.status)) err(`${at}.status`, 'unknown status')
    if (v.params !== undefined) {
      if (!isObj(v.params)) err(`${at}.params`, 'expected an object')
      else for (const [k, n] of Object.entries(v.params)) {
        if (!(PARAMS as readonly string[]).includes(k)) err(`${at}.params.${k}`, 'unknown parameter')
        else if (!isNum(n) || n < 0 || n > 4) err(`${at}.params.${k}`, 'expected a number in 0..4')
      }
    }
    if (v.note !== undefined && typeof v.note !== 'string') err(`${at}.note`, 'expected a string')
    if (v.upscale !== undefined) {
      if (!isObj(v.upscale)) err(`${at}.upscale`, 'expected an object')
      else {
        for (const k of Object.keys(v.upscale)) if (k !== 'model' && k !== 'aiMix') err(`${at}.upscale.${k}`, 'unknown field')
        if (v.upscale.model !== undefined && !(UPSCALE_MODELS as readonly unknown[]).includes(v.upscale.model)) err(`${at}.upscale.model`, `expected one of ${UPSCALE_MODELS.join(', ')}`)
        if (v.upscale.aiMix !== undefined && !(isNum(v.upscale.aiMix) && v.upscale.aiMix >= 0 && v.upscale.aiMix <= 1)) err(`${at}.upscale.aiMix`, 'expected a number in 0..1')
      }
    }
    if (v.pbr !== undefined) validatePbrOverride(`${at}.pbr`, v.pbr, err)
  }
  if (o.classes !== undefined) {
    if (!isObj(o.classes)) err('classes', 'expected an object')
    else for (const [cls, c] of Object.entries(o.classes)) {
      const at = `classes.${cls}`
      if (!(MATERIAL_CLASSES as readonly string[]).includes(cls)) err(at, 'unknown class')
      if (!isObj(c)) {
        err(at, 'expected an object')
        continue
      }
      for (const k of Object.keys(c)) if (k !== 'detail' && k !== 'note') err(`${at}.${k}`, 'unknown field')
      if (c.detail !== undefined && !(DETAIL_ROUTES as readonly unknown[]).includes(c.detail)) err(`${at}.detail`, `expected one of ${DETAIL_ROUTES.join(', ')}`)
      if (c.note !== undefined && typeof c.note !== 'string') err(`${at}.note`, 'expected a string')
    }
  }
  return errors
}

const SDXL_NUMBERS: Record<string, [number, number]> = {
  denoise: [0.05, 1], seamDenoise: [0.05, 1], cn: [0, 2], cfg: [1, 20], steps: [4, 60], cfix: [0.25, 8], seed: [0, 2 ** 31 - 1],
}

function validateSdxlOverride(at: string, v: unknown, err: (path: string, what: string) => void): void {
  if (!isObj(v)) return err(at, 'expected an object')
  for (const [k, n] of Object.entries(v)) {
    const range = SDXL_NUMBERS[k]
    if (range) {
      if (!isNum(n) || n < range[0] || n > range[1]) err(`${at}.${k}`, `expected a number in ${range[0]}..${range[1]}`)
      else if ((k === 'steps' || k === 'seed') && !Number.isInteger(n)) err(`${at}.${k}`, 'expected an integer')
    } else if (k === 'profile') {
      if (!(DETAIL_PROFILES as readonly unknown[]).includes(n)) err(`${at}.${k}`, `expected one of ${DETAIL_PROFILES.join(', ')}`)
    } else if (k === 'prompt' || k === 'sampler') {
      if (!isStr(n)) err(`${at}.${k}`, 'expected a string')
    } else if (k === 'face') {
      if (n === null) continue
      if (!isObj(n)) err(`${at}.face`, 'expected an object or null')
      else {
        const uv = n.uv
        if (!(Array.isArray(uv) && uv.length === 4 && uv.every(x => isNum(x) && x >= 0 && x <= 1) && uv[0] < uv[2] && uv[1] < uv[3])) {
          err(`${at}.face.uv`, 'expected [u0, v0, u1, v1] in 0..1 with u0 < u1 and v0 < v1')
        }
        if (n.denoise !== undefined && !(isNum(n.denoise) && n.denoise >= 0.05 && n.denoise <= 1)) err(`${at}.face.denoise`, 'expected a number in 0.05..1')
        for (const k2 of Object.keys(n)) if (k2 !== 'uv' && k2 !== 'denoise') err(`${at}.face.${k2}`, 'unknown field')
      }
    } else err(`${at}.${k}`, 'unknown field')
  }
}

function validateSet(key: string, s: unknown, sets: Obj, err: (path: string, what: string) => void): void {
  const at = `sets[${JSON.stringify(key)}]`
  const bad = checkKey(key)
  if (bad) err(at, `bad key (${bad})`)
  if (!isObj(s)) return err(at, 'expected an object')
  if (s.key !== key) err(`${at}.key`, 'must equal its record key')
  if (!isSize(s.size)) err(`${at}.size`, 'expected [w, h] positive integers')
  if (!(MATERIAL_CLASSES as readonly unknown[]).includes(s.class)) err(`${at}.class`, `expected one of ${MATERIAL_CLASSES.join(', ')}`)
  if (!(ALPHA_KINDS as readonly unknown[]).includes(s.alpha)) err(`${at}.alpha`, `expected one of ${ALPHA_KINDS.join(', ')}`)
  if (!Array.isArray(s.wrap) || s.wrap.length !== 2 || !s.wrap.every(b => typeof b === 'boolean')) err(`${at}.wrap`, 'expected [boolean, boolean]')
  if (!(PBR_STATUSES as readonly unknown[]).includes(s.status)) err(`${at}.status`, `expected one of ${PBR_STATUSES.join(', ')}`)
  if (typeof s.hero !== 'boolean') err(`${at}.hero`, 'expected a boolean')
  if (s.delit !== undefined && typeof s.delit !== 'boolean') err(`${at}.delit`, 'expected a boolean')
  if (s.uvScale !== undefined && !(isNum(s.uvScale) && s.uvScale > 0)) err(`${at}.uvScale`, 'expected a number > 0')
  if (s.source !== undefined && !(PBR_SOURCES as readonly unknown[]).includes(s.source)) err(`${at}.source`, `expected one of ${PBR_SOURCES.join(', ')}`)
  if (s.detail !== undefined && !(DETAIL_ROUTES as readonly unknown[]).includes(s.detail)) err(`${at}.detail`, `expected one of ${DETAIL_ROUTES.join(', ')}`)
  if (s.tier2x !== undefined && !(isStr(s.tier2x) && isObj(s.tiers) && s.tier2x in s.tiers)) err(`${at}.tier2x`, 'expected the name of one of its tiers')
  if (s.cover !== undefined && !(isNum(s.cover) && s.cover >= 0 && s.cover <= 1)) err(`${at}.cover`, 'expected a number in 0..1')
  if (s.cover !== undefined && !key.startsWith('tile2d:')) err(`${at}.cover`, 'only tile2d: sets carry a cover')
  for (const f of SET_FILES) if (s[f] !== undefined && !isRelFile(s[f])) err(`${at}.${f}`, 'expected a relative file path')
  if (s.params !== undefined) {
    if (!isObj(s.params)) err(`${at}.params`, 'expected an object')
    else for (const [k, v] of Object.entries(s.params)) {
      if (!(PARAMS as readonly string[]).includes(k)) err(`${at}.params.${k}`, 'unknown parameter')
      else if (!isNum(v) || v < 0 || v > 4) err(`${at}.params.${k}`, 'expected a number in 0..4')
    }
  }
  if (key.startsWith('gen:')) {
    if (!isStr(s.replaces)) err(`${at}.replaces`, 'gen: sets must name the set they replace')
    else if (s.replaces.startsWith('gen:')) err(`${at}.replaces`, 'must name a retail key')
  } else if (s.replaces !== undefined) err(`${at}.replaces`, 'only gen: sets replace another set')
  if (s.status === 'replaced' && !Object.values(sets).some(o => isObj(o) && o.replaces === key)) {
    err(`${at}.status`, "'replaced' but no gen: set replaces it")
  }

  if (!isObj(s.tiers)) return err(`${at}.tiers`, 'expected an object')
  const largest = isSize(s.size) ? Math.max(...s.size) : Infinity
  let maxEdge = 0
  for (const [name, t] of Object.entries(s.tiers)) {
    const tp = `${at}.tiers[${JSON.stringify(name)}]`
    if (!isObj(t)) {
      err(tp, 'expected an object')
      continue
    }
    if (!isSize(t.size)) err(`${tp}.size`, 'expected [w, h] positive integers')
    else {
      const edge = Math.max(...t.size)
      if (String(edge) !== name) err(tp, `tier name must be its long edge (${edge})`)
      if (edge > largest) err(tp, `larger than the set size (${largest})`)
      maxEdge = Math.max(maxEdge, edge)
    }
    if (!isRelFile(t.albedo)) err(`${tp}.albedo`, 'expected a relative file path')
    for (const f of TIER_FILES) if (f !== 'albedo' && t[f] !== undefined && !isRelFile(t[f])) err(`${tp}.${f}`, 'expected a relative file path')
    if ((t.nx === undefined) !== (t.ny === undefined)) err(tp, 'nx and ny come together')
    if (!(Number.isInteger(t.bytes) && (t.bytes as number) >= 0)) err(`${tp}.bytes`, 'expected an integer ≥ 0')
  }
  if (Object.keys(s.tiers).length && isSize(s.size) && maxEdge !== largest) err(`${at}.size`, `must equal the largest tier (${maxEdge})`)
}
