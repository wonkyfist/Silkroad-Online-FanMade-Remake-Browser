/**
 * The runtime PBR map loader (docs/WAVE_PLAN3.md D35, D39, D40, D41, D42, §7.1 lane TX-R; docs/RENDER.md §3.2;
 * docs/TEXPIPE.md §6.2–6.4). Two formats feed one runtime record per material:
 *
 *   - `pbr/index.json` (`sro-pbr` v1, the texture pipeline's build output, packages/texpipe/src/format.ts): keyed by
 *     the normalised retail texture path (`keyOf(SidecarMaterial.texture)`) or `tile2d:<stem>`, with per-tier files
 *     (`<map>@<tier>.webp`: albedo plus the v1 planes nx, ny, ao, rough, metal, height), the optional '2x' tier
 *     (`tier2x`) and optional v2 KTX2 files;
 *   - `remaster/manifest.json` (`sro-remaster` v1, hand-made and Meshy sets, apps/game/src/three/remaster.ts): keyed by
 *     `<glb path>#<glTF image name>` (or a bare image name), full files plus RENDER §3.2's optional fields.
 *
 * Precedence (D35): an `sro-remaster` entry for that glb image > an `sro-pbr` set for its retail path > class defaults.
 * A missing index or manifest means "no sets" (D40), silently; a set whose files fail keeps the retail texture.
 *
 * Texture tiers (TX-R; the Options row `graphics.textures`, QualitySettings.render.textures, "applies after reload"):
 * 'auto' follows the preset, Low → retail (the Low guard), Medium → the retail-size remaster + maps for hero sets,
 * High → the '2x' tier (`tier2x`, min(2 × source, 1024); an index without it caps at 1024) with that tier's maps,
 * Ultra → KTX2 when the transcoder is installed and the GPU samples BC7/ASTC, else the WebP tiers ≤ 2048, maps for
 * every `ok` or hero set. 'retail' keeps every retail texture; 'remaster', 1024 and 2048 pin Medium's, High's and
 * Ultra's tier on any PBR preset.
 *
 * Loading never blocks play (TEXPIPE §6.4 "progressive swap"): a material is built with its retail texture; its set's
 * files are fetched and decoded in a worker (pbr/decode-worker.ts: createImageBitmap without premultiplication or
 * colour conversion, the v1 planes packed to a normal map and ORMH, coverage-preserving mips for cutouts), at the
 * lowest streaming priority (`MapScheduler`), and uploaded on the main thread one job per map inside the frame budget
 * (textures.ts `planLevelUpload`: a 1024² map is one job, a 2048² one is split in row bands). When every map of the
 * set is in, they are bound in one go and the embedded retail texture is disposed once nothing draws with it (D41).
 *
 * Textures are shared through a ref-counted cache (PbrTextureCache). ORMH = RGBA8 (R AO, G roughness, B metallic,
 * A height; D37), bound as Babylon's metallic texture with the three `use…FromMetallicTexture…` flags.
 *
 * Owned by TX-R (after RND-M). `parseRemasterManifest` lives here; apps/game/src/three/remaster.ts re-exports it.
 */
import {
  PBRMaterial,
  RawTexture,
  Texture,
  type AssetContainer,
  type BaseTexture,
  type Color3,
  type Material,
  type Scene,
} from '@babylonjs/core'
import {
  PBR_INDEX_FORMAT,
  PBR_INDEX_VERSION,
  keyOf,
  validatePbrIndex,
  type PbrSet,
  type PbrTier,
} from '../../../texpipe/src/format.ts'
import type { DecodedImage } from '../assets.ts'
import { installKtx2Decoder, ktx2DecoderBase, KTX2_DECODER_DIR, KTX2_DECODER_FILES } from '../ktx2.ts'
import { createMippedTexture, planLevelUpload, uploadLevelSteps } from '../textures.ts'
import { classify, classParams, isMaterialClass, resolveClass, type ClassifyHints, type ClassOverrides, type MaterialClass } from './classes.ts'
import {
  chainBytes,
  packNormalPlanes,
  packOrmhPlanes,
  resampleNearest,
  runMapJob,
  type AlphaUse,
  type ImageDecoder,
  type Level,
  type MapJob,
  type MapResult,
  type OrmhDefaults,
} from './decode-core.ts'

export { keyOf } from '../../../texpipe/src/format.ts'
export { packNormalPlanes, packOrmhPlanes, resampleNearest } from './decode-core.ts'
export type { MapJob, MapResult, OrmhDefaults } from './decode-core.ts'

// ---- sro-remaster (RENDER §3.2) -----------------------------------------------------------------------------------

export const REMASTER_FORMAT = 'sro-remaster'
/** Manifest path under an asset root. */
export const REMASTER_MANIFEST = 'remaster/manifest.json'
/** The texture pipeline's index path under an asset root. */
export const PBR_INDEX_PATH = 'pbr/index.json'

export type NormalGreen = 'gl' | 'dx'
export type RemasterAlpha = 'original' | 'albedo'
export type MapKind = 'albedo' | 'normal' | 'metallicRoughness' | 'metallic' | 'roughness' | 'emissive'
/** RENDER §3.2's optional extra maps (linear, R channel). */
export type RemasterExtraMap = 'occlusion' | 'height'

/** One remastered texture: absolute map URLs (resolved against the manifest) plus RENDER §3.2's optional fields. */
export interface RemasterMaps {
  albedo: string
  normal?: string
  metallicRoughness?: string
  metallic?: string
  roughness?: string
  emissive?: string
  /** AO (linear, R); may be the same file as `metallicRoughness` (glTF ORM packing). */
  occlusion?: string
  /** Height (linear, R). */
  height?: string
  normalGreen: NormalGreen
  alpha: RemasterAlpha
  /** RENDER §3.3 class (default: classify). */
  class?: MaterialClass
  /** The albedo had its painted lighting removed (default false: the renderer lowers direct light to 0.8). */
  delit?: boolean
  /** Tiles: retail periods covered by one texture (default 1). */
  uvScale?: number
  /** Long edges written as `<map>@<size>.<ext>` beside each full file (default: only the full file). */
  sizes?: number[]
}

export interface RemasterManifest {
  entries: Map<string, RemasterMaps>
  /** Entries skipped as malformed (for the console). */
  warnings: string[]
}

const MAP_KINDS: readonly (MapKind | RemasterExtraMap)[] = [
  'albedo', 'normal', 'metallicRoughness', 'metallic', 'roughness', 'emissive', 'occlusion', 'height',
]

function resolveUrl(path: string, base: string): string | null {
  try {
    return new URL(path, new URL(base, 'http://localhost')).href.replace(/^http:\/\/localhost(?=\/)/, '')
  } catch {
    return null
  }
}

/**
 * Validates a manifest and resolves its map paths against `manifestUrl` (a same-origin path like
 * '/out/remaster/manifest.json' stays a path). Returns null when it is not a remaster manifest at all.
 */
export function parseRemasterManifest(raw: unknown, manifestUrl: string): RemasterManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.format !== REMASTER_FORMAT || r.version !== 1) return null
  const textures = r.textures
  const out: RemasterManifest = { entries: new Map(), warnings: [] }
  if (!textures || typeof textures !== 'object' || Array.isArray(textures)) return out
  for (const [key, v] of Object.entries(textures as Record<string, unknown>)) {
    if (!key.trim() || key.startsWith('$')) continue
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      out.warnings.push(`${key}: not an object`)
      continue
    }
    const e = v as Record<string, unknown>
    const maps: Partial<Record<MapKind | RemasterExtraMap, string>> = {}
    let bad = ''
    for (const kind of MAP_KINDS) {
      const p = e[kind]
      if (p === undefined || p === null) continue
      const url = typeof p === 'string' && p.trim() ? resolveUrl(p.trim(), manifestUrl) : null
      if (!url) bad ||= `${kind} is not a path`
      else maps[kind] = url
    }
    if (!maps.albedo) bad ||= 'albedo missing'
    if (maps.metallicRoughness && (maps.metallic || maps.roughness)) bad ||= 'metallicRoughness and separate metallic/roughness both given'
    const green = e.normalGreen ?? 'gl'
    if (green !== 'gl' && green !== 'dx') bad ||= `normalGreen must be 'gl' or 'dx'`
    const alpha = e.alpha ?? 'original'
    if (alpha !== 'original' && alpha !== 'albedo') bad ||= `alpha must be 'original' or 'albedo'`
    if (e.class !== undefined && !isMaterialClass(e.class)) bad ||= `unknown class ${JSON.stringify(e.class)}`
    if (e.delit !== undefined && typeof e.delit !== 'boolean') bad ||= 'delit must be a boolean'
    if (e.uvScale !== undefined && !(typeof e.uvScale === 'number' && e.uvScale > 0)) bad ||= 'uvScale must be a number > 0'
    const sizes = e.sizes
    if (sizes !== undefined && !(Array.isArray(sizes) && sizes.every(n => Number.isInteger(n) && (n as number) > 0))) bad ||= 'sizes must be positive integers'
    if (bad) {
      out.warnings.push(`${key}: ${bad}`)
      continue
    }
    const entry: RemasterMaps = { ...maps, albedo: maps.albedo!, normalGreen: green as NormalGreen, alpha: alpha as RemasterAlpha }
    if (e.class !== undefined) entry.class = e.class as MaterialClass
    if (e.delit !== undefined) entry.delit = e.delit as boolean
    if (e.uvScale !== undefined) entry.uvScale = e.uvScale as number
    if (sizes !== undefined) entry.sizes = [...(sizes as number[])].sort((a, b) => a - b)
    out.entries.set(key, entry)
  }
  return out
}

// ---- sro-pbr (TEXPIPE §6.2) ---------------------------------------------------------------------------------------

/** A parsed `pbr/index.json`: the valid sets, and file paths resolved against the index. */
export interface PbrIndexLoaded {
  sets: Map<string, PbrSet>
  /** The folder the set files are relative to (the index URL's folder). */
  base: string
  /** retail key → the `gen:` set that replaces it. */
  replacedBy: Map<string, string>
  warnings: string[]
}

/**
 * Validates an index (texpipe `validatePbrIndex`) and keeps every set without an error; null when it is not an
 * `sro-pbr` v1 index at all (wrong format or version, or no `sets` object).
 */
export function parsePbrIndex(raw: unknown, indexUrl: string): PbrIndexLoaded | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.format !== PBR_INDEX_FORMAT || r.version !== PBR_INDEX_VERSION) return null
  if (!r.sets || typeof r.sets !== 'object' || Array.isArray(r.sets)) return null
  const errors = validatePbrIndex(raw)
  const badKeys = new Set<string>()
  const warnings: string[] = []
  for (const e of errors) {
    const m = /^sets\[("(?:[^"\\]|\\.)*")\]/.exec(e)
    if (m) {
      try {
        badKeys.add(JSON.parse(m[1]!) as string)
      } catch {
        // an unparseable path: the whole message is still reported below
      }
    }
    warnings.push(e)
  }
  const base = resolveUrl('./', indexUrl) ?? indexUrl
  const out: PbrIndexLoaded = { sets: new Map(), base, replacedBy: new Map(), warnings }
  for (const [key, set] of Object.entries(r.sets as Record<string, PbrSet>)) {
    if (badKeys.has(key)) continue
    out.sets.set(key, set)
    if (set.replaces) out.replacedBy.set(set.replaces, key)
  }
  return out
}

// ---- tiers and presets (D39, TX-R) --------------------------------------------------------------------------------

/** The material detail level of a PBR preset (pbr/surface-plugin.ts `materialTier`). */
export type MapTier = 'medium' | 'high' | 'ultra'

/**
 * The Options value (apps/game settings.ts `graphics.textures`, QualitySettings.render.textures): 'auto' follows the
 * preset; the others pin a tier on every PBR preset. Applies after a reload (materials already swapped keep theirs).
 */
export type TextureSetting = 'auto' | 'retail' | 'remaster' | 1024 | 2048
export const TEXTURE_SETTINGS: readonly TextureSetting[] = ['auto', 'retail', 'remaster', 1024, 2048]

export function isTextureSetting(v: unknown): v is TextureSetting {
  return (TEXTURE_SETTINGS as readonly unknown[]).includes(v)
}

/**
 * What a material loads: nothing ('retail': the retail texture and class defaults), the retail-size remaster
 * (Medium), the '2x' tier ≤ 1024 (High), or ≤ 2048 with KTX2 when the GPU can sample it (Ultra).
 */
export type TextureTier = 'retail' | 'remaster' | '2x' | 2048

/** The tier a preset and setting load. 'classic' (Low) is retail unless the setting pins a tier. */
export function textureTierFor(preset: MapTier | 'classic', setting: TextureSetting = 'auto'): TextureTier {
  if (setting === 'retail') return 'retail'
  if (setting === 'remaster') return 'remaster'
  if (setting === 1024) return '2x'
  if (setting === 2048) return 2048
  if (preset === 'classic') return 'retail'
  return preset === 'medium' ? 'remaster' : preset === 'high' ? '2x' : 2048
}

export interface MapPolicy {
  /** The tier this policy loads ('retail': no sets at all). */
  tier: TextureTier
  /** sro-pbr albedo tier: the largest tier ≤ this long edge ('retail' = the smallest, the retail size). */
  albedoCap: number | 'retail'
  /** Take the set's '2x' tier (`tier2x`) for the albedo and its maps when the index has one (High). */
  tier2x: boolean
  /** sro-pbr map tier (normal, ORMH planes) when the '2x' tier does not decide it. */
  mapCap: number | 'retail'
  /** Which sro-pbr sets get maps: only hero sets, or every set whose review status is `ok` (and every hero set). */
  maps: 'hero' | 'all'
  /** Use a set's v2 (KTX2) single files (the WebP tiers stay the fallback). */
  ktx2: boolean
  /** sro-remaster files: the largest listed `sizes` ≤ this, else the full file. */
  remasterCap: number
}

/** The policy of a tier (TEXPIPE §6.4 with the '2x' decision; D39). */
export function policyForTier(tier: TextureTier, ktx2 = false): MapPolicy {
  if (tier === 'retail') return { tier, albedoCap: 'retail', tier2x: false, mapCap: 'retail', maps: 'hero', ktx2: false, remasterCap: 0 }
  if (tier === 'remaster') return { tier, albedoCap: 'retail', tier2x: false, mapCap: 'retail', maps: 'hero', ktx2: false, remasterCap: 1024 }
  if (tier === '2x') return { tier, albedoCap: 1024, tier2x: true, mapCap: 512, maps: 'hero', ktx2: false, remasterCap: 2048 }
  return { tier, albedoCap: 2048, tier2x: false, mapCap: 1024, maps: 'all', ktx2, remasterCap: Infinity }
}

let pageSetting: TextureSetting = 'auto'

/**
 * The page's texture setting (the game sets it once at start-up from its settings and `?textures=`): the tier a world
 * loads with before its first full QualitySettings arrive, and whenever RenderQuality.textures is absent. The setting
 * is read when a material or a tile loads, which is why the Options row says "applies after reload".
 */
export function setPageTextureSetting(s: TextureSetting): void {
  pageSetting = s
}

export function pageTextureSetting(): TextureSetting {
  return pageSetting
}

let pageRemaster = true

/**
 * Whether `loadPbrMapIndex` looks for the sro-remaster manifest at all (I9A). Default on. The release ships
 * `out/remaster/` (the Meshy sets the user approved on 2026-09-29, docs/DEPLOY.md), so the game leaves it on for every
 * page and turns it off only for `?remaster=0` (settings.ts `remasterSetsWanted`).
 */
export function setPageRemasterSets(on: boolean): void {
  pageRemaster = on
}

export function pageRemasterSets(): boolean {
  return pageRemaster
}

/**
 * D39 / TEXPIPE §6.4 for a PBR preset and the Options setting. `ktx2`: the transcoder is installed and usable.
 * D39: "Ultra only with KTX2 (else Ultra uses High's textures)". Without the transcoder the preset route to the 2048
 * tier would load RGBA8 2048 WebPs (1.24 GB resident for the 145 hero sets against High's 443 MB), so Ultra then takes
 * High's policy (the '2x' tier, maps ≤ 512), keeping maps on every reviewed set and the full remaster files (RENDER
 * §3.2; single files, not the RGBA8 tier ladder). An explicit 2048 texture setting
 * (Options, `?textures=2048`) still asks for the WebP 2048 tier.
 */
export function mapPolicy(tier: MapTier, opts: { ktx2?: boolean; textures?: TextureSetting } = {}): MapPolicy {
  const setting = opts.textures ?? 'auto'
  const ktx2 = opts.ktx2 === true
  const t = textureTierFor(tier, setting)
  if (t === 2048 && !ktx2 && setting === 'auto') return { ...policyForTier('2x'), maps: 'all', remasterCap: Infinity }
  return policyForTier(t, ktx2)
}

/** The tier name to load: the largest long edge ≤ cap, else the smallest ('retail': the smallest). null: none. */
export function pickTier(tiers: Readonly<Record<string, PbrTier>>, cap: number | 'retail'): string | null {
  const names = Object.keys(tiers).filter(n => Number.isFinite(Number(n))).sort((a, b) => Number(a) - Number(b))
  if (!names.length) return null
  if (cap === 'retail') return names[0]!
  let best = names[0]!
  for (const n of names) if (Number(n) <= cap) best = n
  return best
}

/** The `sizes` entry to load for a cap (the largest ≤ cap); null = the full file. */
export function pickSize(sizes: readonly number[] | undefined, cap: number): number | null {
  if (!sizes?.length || cap === Infinity) return null
  let best: number | null = null
  for (const s of sizes) if (s <= cap && (best === null || s > best)) best = s
  return best
}

/** `…/albedo.png` + 1024 → `…/albedo@1024.png` (RENDER §3.2 file naming). */
export function sizedUrl(url: string, size: number): string {
  const q = url.search(/[?#]/)
  const path = q < 0 ? url : url.slice(0, q)
  const rest = q < 0 ? '' : url.slice(q)
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  if (dot <= slash) return `${path}@${size}${rest}`
  return `${path.slice(0, dot)}@${size}${path.slice(dot)}${rest}`
}

/** The '2x' tier's name of a set (format.ts `tier2x`, optional in v1; read without depending on the field's type). */
function tier2xOf(set: PbrSet): string | null {
  const t = (set as PbrSet & { tier2x?: unknown }).tier2x
  return typeof t === 'string' && t in set.tiers ? t : null
}

// ---- the runtime record -------------------------------------------------------------------------------------------

export type NormalSource = { kind: 'file'; url: string } | { kind: 'planes'; nx: string; ny: string }

/**
 * Where roughness/metallic/AO/height come from:
 *   - `ormh`: one packed file in D37 order (R AO, G rough, B metal, A height), v2 KTX2;
 *   - `gltf`: a glTF metallicRoughness file (G rough, B metal; R = AO when `ao`);
 *   - `planes`: separate greyscale maps (R of each), packed into ORMH by the decode worker.
 */
export type OrmSource =
  | { kind: 'ormh'; url: string }
  | { kind: 'gltf'; url: string; ao: boolean }
  | { kind: 'planes'; ao?: string; rough?: string; metal?: string; height?: string }

/** One material's maps after precedence and the tier (D35): what toPbr / the actor maps apply. */
export interface PbrMapRecord {
  /** The key that matched (`glb#image`, the image name, or the sro-pbr key). */
  key: string
  origin: 'remaster' | 'pbr'
  /** The set's class (null: classify). */
  cls: MaterialClass | null
  /** sRGB albedo URL (null: keep the retail texture). */
  albedo: string | null
  normal: NormalSource | null
  orm: OrmSource | null
  /** A separate AO file (linear, R), bound as the ambient texture. */
  occlusion: string | null
  emissive: string | null
  normalGreen: NormalGreen
  /** 'original': the retail texture's alpha stays the cutout mask (same UVs). */
  alpha: RemasterAlpha
  delit: boolean
  uvScale: number
  /** The long edge chosen (sro-pbr tier or remaster size); null = the full file. */
  tier: number | null
  params: PbrSet['params'] | null
  /** The URLs are KTX2 files (Babylon's loader transcodes them); `fallback` is the WebP record if they fail. */
  ktx2?: boolean
  fallback?: PbrMapRecord | null
}

/** Which material to look up. */
export interface MapQuery {
  /** The glb path under the asset root without `.glb` (`world/jangan-fields/models/…`, `char/china/…`). */
  glb?: string | null
  /** The glTF image name of the base texture (the retail texture stem). */
  image?: string | null
  /** The retail texture path (SidecarMaterial.texture; any case and slash). */
  texture?: string | null
  /**
   * Actors without a sidecar texture (equipment glbs): join the image name to an sro-pbr key by its file stem; when
   * several keys share the stem (man_item and woman_item), the one sharing the most path segments with the glb wins
   * (a tie joins nothing).
   */
  byStem?: boolean
}

function remasterRecord(key: string, m: RemasterMaps, policy: MapPolicy): PbrMapRecord {
  const size = pickSize(m.sizes, policy.remasterCap)
  const at = (u: string | undefined) => (u ? (size === null ? u : sizedUrl(u, size)) : undefined)
  let orm: OrmSource | null = null
  let occlusion: string | null = null
  if (m.metallicRoughness) {
    const ao = !!m.occlusion && m.occlusion === m.metallicRoughness
    orm = { kind: 'gltf', url: at(m.metallicRoughness)!, ao }
    if (m.occlusion && !ao) occlusion = at(m.occlusion)!
  } else if (m.metallic || m.roughness || m.occlusion || m.height) {
    const planes: { ao?: string; rough?: string; metal?: string; height?: string } = {}
    if (m.occlusion) planes.ao = at(m.occlusion)!
    if (m.roughness) planes.rough = at(m.roughness)!
    if (m.metallic) planes.metal = at(m.metallic)!
    if (m.height) planes.height = at(m.height)!
    orm = { kind: 'planes', ...planes }
  }
  return {
    key,
    origin: 'remaster',
    cls: m.class ?? null,
    albedo: at(m.albedo)!,
    normal: m.normal ? { kind: 'file', url: at(m.normal)! } : null,
    orm,
    occlusion,
    emissive: at(m.emissive) ?? null,
    normalGreen: m.normalGreen,
    alpha: m.alpha,
    delit: m.delit ?? false,
    uvScale: m.uvScale ?? 1,
    tier: size,
    params: null,
  }
}

/** Whether a set gets maps under a policy (hero sets; with 'all' also every reviewed `ok` set). */
function wantsMaps(set: PbrSet, policy: MapPolicy): boolean {
  if (set.status === 'albedo-only') return false
  return policy.maps === 'all' ? set.status === 'ok' || set.hero : set.hero
}

function pbrRecord(set: PbrSet, base: string, policy: MapPolicy): PbrMapRecord | null {
  const file = (rel: string | undefined) => (rel ? resolveUrl(rel, base) : null)
  if (set.status === 'retail') return null
  const wantMaps = wantsMaps(set, policy)
  const common = {
    key: set.key,
    origin: 'pbr' as const,
    cls: set.class,
    occlusion: null,
    normalGreen: 'gl' as const,
    // The pipeline keeps cutout/blend alpha lossless in the albedo (TEXPIPE §6.2), so a cutout or blend set's own alpha
    // is the mask. Any other set ('none', 'specmask') has an opaque albedo: on an alpha-tested or blended material the
    // retail texture stays the mask (W9F TEX-1: the equipped bow_03 / spear_03 turned solid).
    alpha: set.alpha === 'cutout' || set.alpha === 'blend' ? ('albedo' as const) : ('original' as const),
    delit: set.delit ?? false,
    uvScale: set.uvScale ?? 1,
    params: set.params ?? null,
  }
  if (policy.ktx2 && set.albedo) {
    const fallback = pbrRecord(set, base, { ...policy, ktx2: false })
    return {
      ...common,
      albedo: file(set.albedo),
      normal: wantMaps && set.normal ? { kind: 'file', url: file(set.normal)! } : null,
      orm: wantMaps && set.ormh ? { kind: 'ormh', url: file(set.ormh)! } : null,
      emissive: file(set.emissive),
      tier: Math.max(...set.size),
      ktx2: true,
      fallback,
    }
  }
  const t2x = policy.tier2x ? tier2xOf(set) : null
  const name = t2x ?? pickTier(set.tiers, policy.albedoCap)
  if (!name) return null
  const albedo = file(set.tiers[name]!.albedo)
  if (!albedo) return null
  const tier = Number(name)
  let normal: NormalSource | null = null
  let orm: OrmSource | null = null
  if (wantMaps) {
    // Maps from the map tier (the '2x' tier's own planes on High); a tier without planes falls back to the next
    // smaller one (never above the albedo).
    const names = Object.keys(set.tiers).map(Number).filter(n => n <= tier).sort((a, b) => b - a)
    const mapName = t2x ?? pickTier(set.tiers, policy.mapCap)
    const order = mapName ? [Number(mapName), ...names.filter(n => n !== Number(mapName))] : names
    for (const n of order) {
      const t = set.tiers[String(n)]
      if (!t) continue
      if (!normal && t.nx && t.ny) normal = { kind: 'planes', nx: file(t.nx)!, ny: file(t.ny)! }
      if (!orm && (t.ao || t.rough || t.metal || t.height)) {
        const planes: { ao?: string; rough?: string; metal?: string; height?: string } = {}
        if (t.ao) planes.ao = file(t.ao)!
        if (t.rough) planes.rough = file(t.rough)!
        if (t.metal) planes.metal = file(t.metal)!
        if (t.height) planes.height = file(t.height)!
        orm = { kind: 'planes', ...planes }
      }
      if (normal && orm) break
    }
  }
  return { ...common, albedo, normal, orm, emissive: null, tier }
}

/** One terrain tile's jobs for the atlas planes at a layer size (TileAtlas map sources; D36 key `tile2d:<stem>`). */
export interface TileMaps {
  key: string
  /** The albedo at `size` (the tier ≥ size that is closest, resized by the decoder when it differs). */
  albedo(size: number): MapJob
  /** The packed normal map at `size`, or null (the set has no maps under the policy). */
  normal: ((size: number) => MapJob) | null
  /** The packed ORMH at `size` (the set's class and review numbers fill a missing plane), or null. */
  ormh: ((size: number) => MapJob) | null
  /**
   * TT-R (TERRAIN_TEX §5.2 item 4): the tile's share of the export's terrain vertices (0..1, the set's optional `cover`),
   * or null when the set has none. The set range reserves its last layers for tiles at or above the median cover.
   */
  cover: number | null
}

function tileMaps(set: PbrSet, base: string, policy: MapPolicy): TileMaps | null {
  if (set.status === 'retail' || policy.tier === 'retail') return null
  const abs = (rel: string) => resolveUrl(rel, base) ?? rel
  const names = Object.keys(set.tiers).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  if (!names.length) return null
  // The smallest tier at least `size` (downscaled from better data), else the largest there is.
  const atLeast = (size: number, has: (t: PbrTier) => boolean) => {
    const ok = names.filter(n => has(set.tiers[String(n)]!))
    return ok.find(n => n >= size) ?? ok[ok.length - 1]
  }
  const maps = wantsMaps(set, policy)
  const cp = classParams(set.class)
  const defaults: OrmhDefaults = { roughness: set.params?.roughness ?? cp.roughness, metallic: set.params?.metallic ?? cp.metallic }
  const nTier = (size: number) => atLeast(size, t => !!(t.nx && t.ny))
  // ao / rough / metal are half the tier size (TEXPIPE §6.2): the tier twice the layer size has them at the layer size.
  const oTier = (size: number) => atLeast(size * 2, t => !!(t.ao || t.rough || t.metal || t.height))
  return {
    key: set.key,
    cover: typeof set.cover === 'number' && Number.isFinite(set.cover) ? set.cover : null,
    albedo: size => {
      const n = atLeast(size, () => true)!
      return { kind: 'image', url: abs(set.tiers[String(n)]!.albedo), size, levels: true }
    },
    normal: maps && nTier(1) !== undefined
      ? size => {
        const t = set.tiers[String(nTier(size))]!
        return { kind: 'normal', nx: abs(t.nx!), ny: abs(t.ny!), size, levels: true }
      }
      : null,
    ormh: maps && oTier(1) !== undefined
      ? size => {
        const t = set.tiers[String(oTier(size))]!
        const job: MapJob = { kind: 'ormh', defaults, size, levels: true }
        if (t.ao) job.ao = abs(t.ao)
        if (t.rough) job.rough = abs(t.rough)
        if (t.metal) job.metal = abs(t.metal)
        if (t.height) job.height = abs(t.height)
        return job
      }
      : null,
  }
}

/** The lower-case file stem of a key or path ('prim/mtrl/item/x/clothes_01_aa.ddj' → 'clothes_01_aa'). */
function stemOf(path: string): string {
  const file = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = file.lastIndexOf('.')
  return (dot > 0 ? file.slice(0, dot) : file).toLowerCase()
}

/**
 * The loaded map sets of one world (both formats) and the class overrides: `resolve` gives a material its record by
 * D35's precedence, `classOf` its class, `tile` a terrain tile's atlas jobs. An empty index answers null everywhere
 * (D40); so does every lookup under the 'retail' tier.
 */
export class PbrMapIndex {
  static readonly EMPTY = new PbrMapIndex()

  readonly remaster: RemasterManifest | null
  readonly pbr: PbrIndexLoaded | null
  readonly overrides: ClassOverrides | null
  private stems: Map<string, string[]> | null = null

  constructor(opts: { remaster?: RemasterManifest | null; pbr?: PbrIndexLoaded | null; overrides?: ClassOverrides | null } = {}) {
    this.remaster = opts.remaster ?? null
    this.pbr = opts.pbr ?? null
    this.overrides = opts.overrides ?? null
  }

  /** No set at all (every material takes class defaults). */
  get empty(): boolean {
    return !this.remaster?.entries.size && !this.pbr?.sets.size
  }

  /** Some set ships v2 KTX2 files (the Ultra route; loadPbrMapIndex then probes the transcoder). */
  get hasKtx2(): boolean {
    if (!this.pbr) return false
    for (const s of this.pbr.sets.values()) if (s.albedo) return true
    return false
  }

  /** The record for a material, or null (class defaults / the retail texture). */
  resolve(q: MapQuery, policy: MapPolicy): PbrMapRecord | null {
    if (policy.tier === 'retail') return null
    if (this.remaster && q.image) {
      for (const key of [q.glb ? `${q.glb}#${q.image}` : null, q.image]) {
        const m = key ? this.remaster.entries.get(key) : undefined
        if (m) return remasterRecord(key!, m, policy)
      }
    }
    if (!this.pbr) return null
    let key: string | null = q.texture ? keyOf(q.texture) : null
    if (!key && q.byStem && q.image) key = this.keyByStem(q.glb ?? null, q.image)
    if (!key) return null
    const set0 = this.pbr.sets.get(key)
    if (set0?.status === 'replaced') key = this.pbr.replacedBy.get(key) ?? key
    const set = this.pbr.sets.get(key)
    return set ? pbrRecord(set, this.pbr.base, policy) : null
  }

  /** A terrain tile's atlas jobs (`tile2d:<stem>`, D36), or null (retail tile). */
  tile(stem: string, policy: MapPolicy): TileMaps | null {
    if (!this.pbr || policy.tier === 'retail') return null
    const set = this.pbr.sets.get(`tile2d:${stem.toLowerCase()}`)
    return set ? tileMaps(set, this.pbr.base, policy) : null
  }

  /** The class of a texture: the override file > the set's resolved class > classify (RENDER §3.3). */
  classOf(texture: string, hints: ClassifyHints = {}, record?: PbrMapRecord | null): MaterialClass {
    return resolveClass(texture, hints, this.overrides, record?.cls ?? this.pbr?.sets.get(keyOf(texture))?.class ?? null)
  }

  /** The sro-pbr key of a glTF image name by stem (MapQuery.byStem). */
  private keyByStem(glb: string | null, image: string): string | null {
    if (!this.pbr) return null
    if (!this.stems) {
      this.stems = new Map()
      for (const key of this.pbr.sets.keys()) {
        if (key.startsWith('tile2d:') || key.startsWith('gen:')) continue
        const stem = stemOf(key)
        const list = this.stems.get(stem)
        if (list) list.push(key)
        else this.stems.set(stem, [key])
      }
    }
    const list = this.stems.get(image.toLowerCase())
    if (!list?.length) return null
    if (list.length === 1) return list[0]!
    const segs = new Set((glb ?? '').toLowerCase().replace(/\\/g, '/').split('/').filter(Boolean))
    let best: string | null = null
    let bestScore = -1
    let tie = false
    for (const key of list) {
      const score = key.split('/').filter(s => segs.has(s)).length
      if (score > bestScore) {
        best = key
        bestScore = score
        tie = false
      } else if (score === bestScore) tie = true
    }
    return tie ? null : best
  }
}

// ---- loading ------------------------------------------------------------------------------------------------------

/** Bytes by absolute URL (the Assets WorldIO); a rejection = missing. */
export interface MapFetcher {
  bytes(url: string): Promise<Uint8Array<ArrayBuffer>>
}

async function fetchJson(io: MapFetcher, url: string): Promise<unknown> {
  try {
    const text = new TextDecoder().decode(await io.bytes(url))
    return JSON.parse(text) as unknown
  } catch {
    return null // missing, or a dev server's HTML fallback: no sets
  }
}

/**
 * Where the sro-remaster manifest is looked for: `/out/remaster/manifest.json` first when the asset root is the
 * slimmed `/out-opt/` tree (RENDER §3.2 and remaster.ts: optimize-out copies the manifest later, /out/ holds the
 * current one), then the root's own.
 */
export function remasterManifestUrls(root: string): string[] {
  const own = new URL(REMASTER_MANIFEST, root).href
  const m = /^(.*\/)out-opt\/$/.exec(root)
  return m ? [new URL(`out/${REMASTER_MANIFEST}`, m[1]).href, own] : [own]
}

/**
 * Loads `pbr/index.json` and the `remaster/manifest.json` under `rootUrl` (an asset root such as `/out-opt/`). Either
 * may be missing: that is "no sets", never an error (D40). Malformed entries are skipped with one console.warn each
 * file. When the index lists KTX2 files and the vendored transcoder answers under `<root>_decoders/ktx2/`, the
 * transcoder is installed (ktx2.ts, every URLConfig entry local) so Ultra can take the KTX2 route.
 */
export async function loadPbrMapIndex(io: MapFetcher, rootUrl: string, opts: { overrides?: ClassOverrides | null; ktx2?: boolean; remaster?: boolean } = {}): Promise<PbrMapIndex> {
  const root = rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`
  const pbrUrl = new URL(PBR_INDEX_PATH, root).href
  const remasterUrls = (opts.remaster ?? pageRemaster) ? remasterManifestUrls(root) : []
  const loadRemaster = async (): Promise<{ raw: unknown; url: string } | null> => {
    for (const url of remasterUrls) {
      const raw = await fetchJson(io, url)
      if (raw) return { raw, url }
    }
    return null
  }
  const [pbrRaw, rem] = await Promise.all([fetchJson(io, pbrUrl), loadRemaster()])
  const pbr = pbrRaw ? parsePbrIndex(pbrRaw, pbrUrl) : null
  const remaster = rem ? parseRemasterManifest(rem.raw, rem.url) : null
  if (pbr?.warnings.length) console.warn(`[pbr] ${pbrUrl}: ${pbr.warnings.length} problem(s), first: ${pbr.warnings[0]}`)
  if (remaster?.warnings.length) console.warn(`[pbr] ${rem!.url}: ${remaster.warnings.join('; ')}`)
  const index = new PbrMapIndex({ pbr, remaster, overrides: opts.overrides ?? null })
  if (opts.ktx2 !== false && index.hasKtx2 && !ktx2DecoderBase()) {
    try {
      await io.bytes(new URL(KTX2_DECODER_DIR + KTX2_DECODER_FILES.jsDecoderModule, root).href)
      installKtx2Decoder(root)
    } catch {
      // No vendored transcoder under this root (the deploy leaves KTX2 out): Ultra takes the WebP tiers.
    }
  }
  return index
}

/** The KTX2 route is usable: the transcoder is installed and the GPU samples BC7 or ASTC (else it would be RGBA8). */
export function ktx2MapsAvailable(scene: Scene): boolean {
  if (!ktx2DecoderBase()) return false
  const caps = scene.getEngine().getCaps() as { bptc?: unknown; astc?: unknown }
  return !!caps.bptc || !!caps.astc
}

// ---- packing (pure; decode-core.ts) -------------------------------------------------------------------------------

/** An RGBA8 image (rows in file order). */
export type Rgba = DecodedImage

/**
 * glTF normal maps (+Y up) in Babylon: the loader's inversions for the scene's handedness; a DirectX-style map ('dx',
 * green pointing down) flips Y on top of that (the same rule as remaster.ts `normalInversions`).
 */
export function normalInvert(rightHanded: boolean, green: NormalGreen): { x: boolean; y: boolean } {
  const y = rightHanded
  return { x: !rightHanded, y: green === 'dx' ? !y : y }
}

// ---- scheduling: the lowest streaming priority and the frame budget ----------------------------------------------

/**
 * Where map work runs (TEXPIPE §6.4 "progressive swap"): `request` wraps a fetch + decode (the region streamer's
 * limiter at its lowest priority, so regions and models always go first), `job` a main-thread upload (the streamer's
 * per-frame job queue, after every region job). The default runs both at once (tests, and scenes that set nothing).
 */
export interface MapScheduler {
  request<T>(fn: () => Promise<T>): Promise<T>
  job(run: () => void): void
}

export const IMMEDIATE_SCHEDULER: MapScheduler = {
  request: fn => fn(),
  job: run => run(),
}

/**
 * A scheduler for a scene without a region streamer (the character screens): at most `concurrency` decodes in
 * flight, upload jobs run before each render until `budgetMs` is used (at least one per frame).
 */
export function frameScheduler(scene: Scene, opts: { budgetMs?: number; concurrency?: number } = {}): MapScheduler & { dispose(): void; readonly queued: number } {
  const budget = opts.budgetMs ?? 3
  const max = Math.max(1, opts.concurrency ?? 2)
  const jobs: Array<() => void> = []
  const waiting: Array<() => void> = []
  let active = 0
  const obs = scene.onBeforeRenderObservable.add(() => {
    const t0 = performance.now()
    while (jobs.length) {
      const run = jobs.shift()!
      try {
        run()
      } catch (err) {
        console.warn('[pbr] map job failed', err)
      }
      if (performance.now() - t0 >= budget) break
    }
  })
  return {
    request<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          active++
          fn().then(resolve, reject).finally(() => {
            active--
            waiting.shift()?.()
          })
        }
        if (active < max) start()
        else waiting.push(start)
      })
    },
    job(run) {
      jobs.push(run)
    },
    get queued() {
      return jobs.length + waiting.length + active
    },
    dispose() {
      scene.onBeforeRenderObservable.remove(obs)
      jobs.length = 0
      waiting.length = 0
    },
  }
}

// ---- the decode worker (decode-worker.ts) -------------------------------------------------------------------------

function absoluteUrl(url: string): string {
  try {
    return new URL(url, (globalThis as { location?: { href?: string } }).location?.href ?? 'http://localhost/').href
  } catch {
    return url
  }
}

/** The job with absolute URLs (a worker resolves relative URLs against its own script). */
function absoluteJob(job: MapJob): MapJob {
  if (job.kind === 'image') return { ...job, url: absoluteUrl(job.url) }
  if (job.kind === 'normal') return { ...job, nx: absoluteUrl(job.nx), ny: absoluteUrl(job.ny) }
  const out: MapJob = { ...job }
  for (const k of ['ao', 'rough', 'metal', 'height'] as const) if (job[k]) out[k] = absoluteUrl(job[k])
  return out
}

interface WorkerSlot {
  worker: Worker
  busy: number
}

interface PendingDecode {
  job: MapJob
  fallback: ImageDecoder
  slot: WorkerSlot
  resolve: (r: MapResult) => void
  reject: (e: Error) => void
}

/**
 * The page's decode workers (at most `max`, started on demand): `run` posts a job to the least busy one, or runs it on
 * the main thread through `fallback` when workers cannot run (no Worker / OffscreenCanvas, a worker that failed to
 * start: then every pending job is re-run on the main thread and no worker is tried again).
 */
export class MapDecoder {
  private readonly slots: WorkerSlot[] = []
  private readonly pending = new Map<number, PendingDecode>()
  private seq = 0
  private broken = false
  /** Jobs decoded by a worker / on the main thread (the console, tests). */
  readonly counts = { worker: 0, main: 0 }

  constructor(private readonly max = 2) {}

  get usesWorkers(): boolean {
    return !this.broken && this.slots.length > 0
  }

  run(job: MapJob, fallback: ImageDecoder): Promise<MapResult> {
    const slot = this.slot()
    if (!slot) {
      this.counts.main++
      return runMapJob(job, fallback)
    }
    return new Promise<MapResult>((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { job, fallback, slot, resolve, reject })
      slot.busy++
      slot.worker.postMessage({ id, job: absoluteJob(job) })
    })
  }

  private slot(): WorkerSlot | null {
    if (this.broken || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null
    if (this.slots.length < this.max && this.slots.every(s => s.busy > 0)) this.spawn()
    let best: WorkerSlot | null = null
    for (const s of this.slots) if (!best || s.busy < best.busy) best = s
    return best
  }

  private spawn(): void {
    let worker: Worker
    try {
      worker = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module', name: 'sro-map-decode' })
    } catch (err) {
      this.fail(`${err}`)
      return
    }
    const slot: WorkerSlot = { worker, busy: 0 }
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { ready?: boolean; id?: number; result?: MapResult; error?: string }
      if (m.ready || m.id === undefined) return
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      slot.busy--
      if (m.error !== undefined) p.reject(new Error(m.error))
      else {
        this.counts.worker++
        p.resolve(m.result!)
      }
    }
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault?.()
      this.fail(e.message || 'worker error')
    }
    this.slots.push(slot)
  }

  private fail(why: string): void {
    if (!this.broken) console.warn('[pbr] texture decode worker unavailable; decoding on the main thread:', why)
    this.broken = true
    for (const s of this.slots.splice(0)) s.worker.terminate()
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) {
      this.counts.main++
      runMapJob(p.job, p.fallback).then(p.resolve, p.reject)
    }
  }

  dispose(): void {
    for (const s of this.slots.splice(0)) s.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error('decoder disposed'))
    this.pending.clear()
  }
}

let pageDecoder: MapDecoder | null = null

/** The page's shared decoder (two workers). */
export function sharedMapDecoder(): MapDecoder {
  return (pageDecoder ??= new MapDecoder(2))
}

// ---- textures -----------------------------------------------------------------------------------------------------

/** Makes map textures (tests pass fakes; the game and viewer load URLs). */
export interface MapTextureSource {
  /** A URL texture laid out like the glTF loader's (no Y flip, trilinear, repeat): KTX2 files and old callers. */
  texture(url: string, srgb: boolean): BaseTexture
  /** RGBA8 pixels of an image URL (no colour conversion, no premultiplication), optionally at size × size. */
  pixels(url: string, size?: number): Promise<Rgba>
  /** A texture from packed pixels (mipmapped, repeat, linear). */
  raw(img: Rgba): BaseTexture
  /** TX-R: decodes a job, off the main thread when it can (default: `runMapJob` over `pixels`). */
  decode?(job: MapJob): Promise<MapResult>
  /**
   * TX-R: an empty texture for decoded levels plus its upload jobs (each returns false when the engine refused);
   * default: `raw(level 0)` and no job.
   */
  upload?(r: MapResult, name: string): { texture: BaseTexture; jobs: Array<() => boolean> }
  /** TX-R: resolves once a URL texture from `texture` has loaded (KTX2), rejects when it failed. Default: at once. */
  loaded?(tex: BaseTexture): Promise<void>
}

/** The browser source: Babylon URL textures (KTX2), the decode workers and the leveled uploads of textures.ts. */
export function urlMapSource(
  scene: Scene,
  fetchBytes: (url: string) => Promise<Uint8Array<ArrayBuffer>>,
  decode: (bytes: Uint8Array<ArrayBuffer>, mime: string, size?: number) => Promise<Rgba>,
  decoder: MapDecoder | null = sharedMapDecoder(),
): MapTextureSource {
  const status = new WeakMap<BaseTexture, Promise<void>>()
  const mime = (url: string) => {
    const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url)?.[1]?.toLowerCase()
    return ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'
  }
  const pixels = async (url: string, size?: number) => decode(await fetchBytes(url), mime(url), size)
  return {
    texture(url, srgb) {
      let done!: () => void
      let fail!: (e: Error) => void
      const p = new Promise<void>((resolve, reject) => {
        done = resolve
        fail = reject
      })
      p.catch(() => {})
      const t = new Texture(url, scene, {
        noMipmap: false,
        invertY: false,
        samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
        gammaSpace: srgb,
        onLoad: () => done(),
        onError: (msg?: string) => fail(new Error(`${url}: ${msg ?? 'load failed'}`)),
      })
      t.gammaSpace = srgb
      status.set(t, p)
      return t
    },
    pixels,
    raw(img) {
      const t = RawTexture.CreateRGBATexture(img.data, img.width, img.height, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
      t.gammaSpace = false
      t.wrapU = Texture.WRAP_ADDRESSMODE
      t.wrapV = Texture.WRAP_ADDRESSMODE
      return t
    },
    decode(job) {
      return decoder ? decoder.run(job, pixels) : runMapJob(job, pixels)
    },
    upload(r, name) {
      const texture = createMippedTexture(scene, r.width, r.height, name)
      const jobs = planLevelUpload(r.levels).map(steps => () => uploadLevelSteps(scene, texture, steps))
      return { texture, jobs }
    },
    loaded(tex) {
      return status.get(tex) ?? Promise.resolve()
    },
  }
}

interface CacheEntry {
  tex: BaseTexture | null
  pending: Promise<BaseTexture> | null
  /** Owners (released through `release(tex)` once the texture exists). */
  refs: number
  /** Owners still waiting (a material disposed before its map arrived gives its claim back with `unwant`). */
  wanted: number
  /** Resident bytes (a full RGBA8 chain of what was uploaded; 0 for URL textures). */
  bytes: number
  /** Dropped before its upload (nobody wanted it): a new claim starts over. */
  cancelled?: boolean
}

/** Rejection of a map nobody wants any more (not a failure; not logged). */
export class MapCancelled extends Error {
  constructor() {
    super('map no longer wanted')
    this.name = 'MapCancelled'
  }
}

/**
 * Map textures shared by every material that uses them, by key (the URL and colour space, or a job key), with
 * reference counts: the texture is disposed when its last user releases it (ObjectMaterials.release, releaseMaps).
 * `acquireMap` runs the TX-R path: decode (worker) at the scheduler's request priority, then the upload jobs one per
 * frame-budget slot; a map nobody wants any more before its upload is dropped without being uploaded.
 */
export class PbrTextureCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly keyOfTex = new Map<BaseTexture, string>()
  failures = 0
  scheduler: MapScheduler = IMMEDIATE_SCHEDULER
  /** Upload jobs run, their total and longest main-thread time (ms), maps made, resident bytes of maps made here. */
  readonly stats = { uploads: 0, uploadMs: 0, uploadMaxMs: 0, maps: 0, bytes: 0, cancelled: 0, retailReleased: 0, retailBytes: 0 }
  /** The last 256 upload job times (ms; the console and the TX-R budget check). */
  readonly uploadTimes: number[] = []

  constructor(readonly source: MapTextureSource) {}

  /** Where decodes and uploads run (null: at once). */
  setScheduler(s: MapScheduler | null): void {
    this.scheduler = s ?? IMMEDIATE_SCHEDULER
  }

  /** Textures alive. */
  get size(): number {
    return this.entries.size
  }

  /** A URL texture (sync; it loads in the background). */
  acquire(url: string, srgb: boolean): BaseTexture {
    const key = `${srgb ? 's' : 'l'}|${url}`
    let e = this.entries.get(key)
    if (!e) {
      const tex = this.source.texture(url, srgb)
      e = { tex, pending: null, refs: 0, wanted: 0, bytes: 0 }
      this.entries.set(key, e)
      this.keyOfTex.set(tex, key)
    }
    e.refs++
    return e.tex!
  }

  /** A URL texture once it has loaded (KTX2); rejects (and gives the claim back) when it failed. */
  acquireLoaded(url: string, srgb: boolean): Promise<BaseTexture> {
    const tex = this.acquire(url, srgb)
    return (this.source.loaded?.(tex) ?? Promise.resolve()).then(() => tex, err => {
      this.failures++
      this.release(tex)
      throw err
    })
  }

  /** A packed texture built once per key (planes decoded and packed); rejects when a plane fails. */
  acquirePacked(key: string, build: () => Promise<Rgba>): Promise<BaseTexture> {
    const k = `p|${key}`
    let e = this.entries.get(k)
    if (!e) {
      const entry: CacheEntry = { tex: null, pending: null, refs: 0, wanted: 0, bytes: 0 }
      entry.pending = build().then(img => {
        const tex = this.source.raw(img)
        entry.tex = tex
        this.keyOfTex.set(tex, k)
        if (entry.refs <= 0) this.drop(k, entry)
        return tex
      }, err => {
        this.failures++
        this.entries.delete(k)
        throw err
      })
      e = entry
      this.entries.set(k, e)
    }
    e.refs++
    return e.pending ?? Promise.resolve(e.tex!)
  }

  /** The cache key `acquireMap` uses for a job key (for `unwant`). */
  mapKey(key: string, srgb: boolean): string {
    return `m|${srgb ? 's' : 'l'}|${key}`
  }

  /**
   * A map made through the decode worker and the scheduled uploads (TX-R): `key` names the job's content (URLs and
   * options), `name` the texture. Resolves with the uploaded texture; rejects when a file or an upload failed, or with
   * MapCancelled when every claim was given back first.
   */
  acquireMap(key: string, job: MapJob, srgb: boolean, name: string): Promise<BaseTexture> {
    const k = this.mapKey(key, srgb)
    let e = this.entries.get(k)
    if (e?.cancelled) e = undefined
    if (!e) {
      // The claim is counted before the request starts (a scheduler may run it at once).
      const entry: CacheEntry = { tex: null, pending: null, refs: 1, wanted: 1, bytes: 0 }
      this.entries.set(k, entry)
      entry.pending = this.scheduler.request(() => {
        if (entry.wanted <= 0) {
          entry.cancelled = true
          return Promise.reject(new MapCancelled())
        }
        return this.source.decode ? this.source.decode(job) : runMapJob(job, url => this.source.pixels(url))
      }).then(r => this.upload(r, srgb, name, entry)).then(tex => {
        entry.tex = tex
        this.keyOfTex.set(tex, k)
        this.stats.maps++
        if (entry.refs <= 0) this.drop(k, entry)
        return tex
      }, (err: unknown) => {
        if (err instanceof MapCancelled) this.stats.cancelled++
        else this.failures++
        if (this.entries.get(k) === entry) this.entries.delete(k)
        throw err
      })
      return entry.pending
    }
    e.refs++
    e.wanted++
    return e.pending ?? Promise.resolve(e.tex!)
  }

  /** A claim from `acquireMap` given back before its texture arrived (the material went first). */
  unwant(key: string, srgb: boolean): void {
    const e = this.entries.get(this.mapKey(key, srgb))
    if (e && !e.tex && e.wanted > 0) e.wanted--
  }

  /** Runs a decoded result's upload jobs through the scheduler, timing each (the "≤ 5 ms per job" check). */
  private upload(r: MapResult, srgb: boolean, name: string, entry: CacheEntry): Promise<BaseTexture> {
    return new Promise<BaseTexture>((resolve, reject) => {
      let made: { texture: BaseTexture; jobs: Array<() => boolean> } | null = null
      let i = 0
      const step = () => {
        if (entry.wanted <= 0) {
          entry.cancelled = true
          made?.texture.dispose()
          reject(new MapCancelled())
          return
        }
        const t0 = performance.now()
        let ok = true
        try {
          if (!made) {
            made = this.source.upload ? this.source.upload(r, name) : { texture: this.source.raw(r.levels[0]!), jobs: [] }
            made.texture.gammaSpace = srgb
          }
          if (i < made.jobs.length) ok = made.jobs[i++]!()
        } catch (err) {
          ok = false
          console.warn('[pbr] upload failed', name, err)
        }
        const ms = performance.now() - t0
        this.stats.uploads++
        this.stats.uploadMs += ms
        if (this.uploadTimes.push(ms) > 256) this.uploadTimes.shift()
        if (ms > this.stats.uploadMaxMs) this.stats.uploadMaxMs = ms
        if (!ok) {
          made?.texture.dispose()
          reject(new Error(`${name}: upload failed`))
          return
        }
        if (i < made!.jobs.length) this.scheduler.job(step)
        else {
          entry.bytes = made!.jobs.length ? chainBytes(r.width, r.height) : 0
          this.stats.bytes += entry.bytes
          resolve(made!.texture)
        }
      }
      this.scheduler.job(step)
    })
  }

  /** Releases one use of a texture (unknown textures are ignored). */
  release(tex: BaseTexture): void {
    const key = this.keyOfTex.get(tex)
    const e = key ? this.entries.get(key) : undefined
    if (!key || !e) return
    if (--e.refs <= 0) this.drop(key, e)
  }

  private drop(key: string, e: CacheEntry): void {
    this.entries.delete(key)
    this.stats.bytes -= e.bytes
    e.bytes = 0
    if (e.tex) {
      this.keyOfTex.delete(e.tex)
      e.tex.dispose()
    }
  }

  dispose(): void {
    for (const e of this.entries.values()) e.tex?.dispose()
    this.entries.clear()
    this.keyOfTex.clear()
    this.stats.bytes = 0
  }
}

// ---- applying a record to a PBRMaterial: the progressive swap -----------------------------------------------------

/** What applyMapRecord bound or is loading (released with releaseMaps). */
export interface AppliedMaps {
  textures: BaseTexture[]
  /** Map claims still loading (cache key, colour space), given back if the material goes first. */
  pending: Set<string>
  /** The record set a normal map / an ORMH roughness (the surface plugin's luma roughness is off then). */
  normal: boolean
  roughness: boolean
  disposed: boolean
  /** The set's textures are bound (the retail texture was swapped out). */
  swapped: boolean
  /** Resolves true once swapped, false when the set failed or the material went first (the retail look stays). */
  ready: Promise<boolean>
}

export interface ApplyOptions {
  /** Runs once when the set's textures are bound (the surface plugin re-reads its flags). */
  onChange?: () => void
  /**
   * The retail albedo is no longer drawn by this material after the swap (D41). Default: disposed when no material
   * of the scene still uses it.
   */
  onRetailFree?: (tex: BaseTexture) => void
}

const isCutoutMode = (m: PBRMaterial) => m.transparencyMode === PBRMaterial.PBRMATERIAL_ALPHATEST || m.transparencyMode === PBRMaterial.PBRMATERIAL_ALPHATESTANDBLEND
const isBlendMode = (m: PBRMaterial) => m.transparencyMode === PBRMaterial.PBRMATERIAL_ALPHABLEND

/** Disposes a texture no material of its scene uses any more (true when it did). */
export function disposeIfUnused(tex: BaseTexture): boolean {
  const scene = tex.getScene()
  if (scene && scene.materials.some(m => m.hasTexture(tex))) return false
  tex.dispose()
  return true
}

type Slot = 'albedo' | 'normal' | 'orm' | 'occlusion' | 'emissive'

const OPACITY_ALPHA_TEST = new WeakSet<PBRMaterial>()

/**
 * The shadow and depth passes cut an alpha-tested material with getAlphaTestTexture(), which a PBRMaterial answers with
 * its albedo. Once a swap keeps the retail texture as the opacity mask (an opaque set albedo), they must read that mask
 * instead, or the cut-away parts cast solid shadows.
 */
function alphaTestFromOpacity(mat: PBRMaterial): void {
  if (OPACITY_ALPHA_TEST.has(mat)) return
  OPACITY_ALPHA_TEST.add(mat)
  const base = mat.getAlphaTestTexture.bind(mat)
  mat.getAlphaTestTexture = () => (!mat.useAlphaFromAlbedoTexture && mat.opacityTexture ? mat.opacityTexture : base())
}

// ---- placeholders: the define set is final from the start (W9F R3) ------------------------------------------------

const PLACEHOLDERS = new WeakMap<Scene, Map<string, RawTexture>>()

/** A shared 1 × 1 RGBA8 texture of `scene` (linear unless `srgb`). */
function pixel(scene: Scene, key: string, rgba: readonly [number, number, number, number], srgb = false): RawTexture {
  let m = PLACEHOLDERS.get(scene)
  if (!m) PLACEHOLDERS.set(scene, (m = new Map()))
  let t = m.get(key)
  if (!t || t.getScene() !== scene || !t.getInternalTexture()) {
    t = RawTexture.CreateRGBATexture(new Uint8Array(rgba), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE)
    t.name = `sroPlaceholder:${key}`
    t.gammaSpace = srgb
    // The data is uploaded synchronously; the NullEngine (headless tests, CI) just never flags it ready.
    const internal = t.getInternalTexture()
    if (internal) internal.isReady = true
    m.set(key, t)
  }
  return t
}

const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
const ormHasAo = (o: OrmSource): boolean => (o.kind === 'ormh' ? true : o.kind === 'gltf' ? !!o.ao : !!o.ao)

/** What the placeholders changed on a material (restored when the set fails). */
interface HeldState {
  undo: Array<() => void>
  textures: Set<BaseTexture>
}

/**
 * Binds neutral stand-ins for every map `rec` will bring (a flat normal, a 1 × 1 ORMH with the class roughness and
 * metallic, a white AO, a black emissive) and the flags that go with them, so the material compiles its final define
 * set with the warm-up and the swap only rebinds textures (as the terrain atlas does, TEXPIPE §6.4). Before, the maps
 * landing in play added METALLICWORKFLOW, REFLECTIVITY…, BUMP, SPECULARAA and a new effect per material variant, for
 * the first minute of a visit (W9F R3). The retail albedo stays drawn until the set's is in; until then the surface
 * reads the class roughness instead of the retail luminance roughness.
 */
function holdPlaceholders(mat: PBRMaterial, rec: PbrMapRecord, defaults: { roughness: number; metallic: number }, mask: BaseTexture | null): HeldState {
  const scene = mat.getScene()
  const held: HeldState = { undo: [], textures: new Set() }
  const set = <K extends keyof PBRMaterial>(k: K, v: PBRMaterial[K]) => {
    const was = mat[k]
    held.undo.push(() => {
      if (mat[k] === v) (mat as unknown as Record<string, unknown>)[k as string] = was
    })
    ;(mat as unknown as Record<string, unknown>)[k as string] = v
  }
  const tex = <K extends 'bumpTexture' | 'metallicTexture' | 'ambientTexture' | 'emissiveTexture'>(k: K, t: RawTexture) => {
    held.textures.add(t)
    set(k, t as PBRMaterial[K])
  }
  if (rec.normal) {
    tex('bumpTexture', pixel(scene, 'normal', [128, 128, 255, 255]))
    set('enableSpecularAntiAliasing', true)
  }
  if (rec.orm) {
    const r = byte(defaults.roughness), m = byte(defaults.metallic)
    tex('metallicTexture', pixel(scene, `ormh:${r}:${m}`, [255, r, m, 128]))
    set('useAmbientOcclusionFromMetallicTextureRed', ormHasAo(rec.orm))
    set('useRoughnessFromMetallicTextureGreen', true)
    set('useMetallnessFromMetallicTextureBlue', true)
    set('useRoughnessFromMetallicTextureAlpha', false)
    set('metallic', 1)
    set('roughness', 1)
  }
  if (rec.occlusion) {
    tex('ambientTexture', pixel(scene, 'white', [255, 255, 255, 255]))
    set('useAmbientInGrayScale', true)
  }
  if (rec.emissive) {
    tex('emissiveTexture', pixel(scene, 'black', [0, 0, 0, 255], true))
    const was = mat.emissiveColor.clone()
    held.undo.push(() => mat.emissiveColor.copyFrom(was))
    mat.emissiveColor.set(1, 1, 1)
  }
  if (rec.alpha === 'original' && mask) {
    // The retail texture is already the albedo: as the opacity mask too it draws the same, with the swap's defines.
    set('opacityTexture', mask)
    set('useAlphaFromAlbedoTexture', false)
    alphaTestFromOpacity(mat)
  }
  return held
}

const HELD = new WeakMap<AppliedMaps, HeldState>()

/** The material state a swap may change, as it was before applyMapRecord (restoreMaps puts it back; W9F LG-4). */
interface MaterialSnapshot {
  albedoTexture: BaseTexture | null
  opacityTexture: BaseTexture | null
  useAlphaFromAlbedoTexture: boolean
  bumpTexture: BaseTexture | null
  invertNormalMapX: boolean
  invertNormalMapY: boolean
  enableSpecularAntiAliasing: boolean
  metallicTexture: BaseTexture | null
  useAmbientOcclusionFromMetallicTextureRed: boolean
  useRoughnessFromMetallicTextureGreen: boolean
  useMetallnessFromMetallicTextureBlue: boolean
  useRoughnessFromMetallicTextureAlpha: boolean
  metallic: number | null
  roughness: number | null
  ambientTexture: BaseTexture | null
  useAmbientInGrayScale: boolean
  emissiveTexture: BaseTexture | null
  emissiveColor: Color3
  directIntensity: number
  albedoHasAlpha: boolean | null
}

const SNAPSHOT = new WeakMap<AppliedMaps, MaterialSnapshot>()

function snapshotOf(mat: PBRMaterial): MaterialSnapshot {
  return {
    albedoTexture: mat.albedoTexture,
    opacityTexture: mat.opacityTexture,
    useAlphaFromAlbedoTexture: mat.useAlphaFromAlbedoTexture,
    bumpTexture: mat.bumpTexture,
    invertNormalMapX: mat.invertNormalMapX,
    invertNormalMapY: mat.invertNormalMapY,
    enableSpecularAntiAliasing: mat.enableSpecularAntiAliasing,
    metallicTexture: mat.metallicTexture,
    useAmbientOcclusionFromMetallicTextureRed: mat.useAmbientOcclusionFromMetallicTextureRed,
    useRoughnessFromMetallicTextureGreen: mat.useRoughnessFromMetallicTextureGreen,
    useMetallnessFromMetallicTextureBlue: mat.useMetallnessFromMetallicTextureBlue,
    useRoughnessFromMetallicTextureAlpha: mat.useRoughnessFromMetallicTextureAlpha,
    metallic: mat.metallic,
    roughness: mat.roughness,
    ambientTexture: mat.ambientTexture,
    useAmbientInGrayScale: mat.useAmbientInGrayScale,
    emissiveTexture: mat.emissiveTexture,
    emissiveColor: mat.emissiveColor.clone(),
    directIntensity: mat.directIntensity,
    albedoHasAlpha: mat.albedoTexture ? mat.albedoTexture.hasAlpha : null,
  }
}

function releasePlaceholders(mat: PBRMaterial, held: HeldState): void {
  for (const u of held.undo.reverse()) u()
  held.undo.length = 0
  unbindPlaceholders(mat, held)
}

function unbindPlaceholders(mat: PBRMaterial, held: HeldState): void {
  if (held.textures.has(mat.bumpTexture as BaseTexture)) mat.bumpTexture = null
  if (held.textures.has(mat.metallicTexture as BaseTexture)) mat.metallicTexture = null
  if (held.textures.has(mat.ambientTexture as BaseTexture)) mat.ambientTexture = null
  if (held.textures.has(mat.emissiveTexture as BaseTexture)) mat.emissiveTexture = null
}

/**
 * The progressive swap (TEXPIPE §6.4, RENDER §3.2): starts loading a record's maps and, once every map is in (or
 * failed), binds them on `mat` in one go: the albedo replaces the retail texture (its alpha stays the cutout mask when
 * `alpha` is 'original'), the normal map (with specular anti-aliasing, DETAIL H3), ORMH as the metallic texture
 * (D37), AO, emissive; `params` from the review; non-de-lit sets get directIntensity 0.8. Until then the material
 * draws its retail texture. A set whose albedo fails keeps the retail look (a KTX2 set tries its WebP fallback); a map
 * that fails leaves that map to the class defaults. `opts` may be the onChange callback (the older signature).
 */
export function applyMapRecord(mat: PBRMaterial, rec: PbrMapRecord, cache: PbrTextureCache, cls: MaterialClass, opts?: (() => void) | ApplyOptions): AppliedMaps {
  const o: ApplyOptions = typeof opts === 'function' ? { onChange: opts } : opts ?? {}
  const applied: AppliedMaps = { textures: [], pending: new Set(), normal: false, roughness: false, disposed: false, swapped: false, ready: Promise.resolve(false) }
  const retail = mat.albedoTexture
  const p = classParams(cls)
  const params = rec.params ?? {}
  const defaults = { roughness: params.roughness ?? p.roughness, metallic: params.metallic ?? p.metallic }
  const cutout = isCutoutMode(mat)
  const blend = isBlendMode(mat)
  SNAPSHOT.set(applied, snapshotOf(mat))
  // The final define set from the start (W9F R3): the swap below only rebinds textures.
  const held = holdPlaceholders(mat, rec, defaults, (cutout || blend) && retail ? retail : null)
  HELD.set(applied, held)
  applied.normal = rec.normal !== null
  applied.roughness = rec.orm !== null

  const attempt = async (r: PbrMapRecord): Promise<boolean> => {
    const alphaUse: AlphaUse = r.alpha === 'albedo' ? (cutout ? 'cutout' : blend ? 'blend' : 'none') : 'none'
    const cutoff = mat.alphaCutOff
    const loads: Array<{ slot: Slot; ao?: boolean; claim: string | null; srgb: boolean; p: Promise<BaseTexture> }> = []
    const url = (slot: Slot, u: string, srgb: boolean, extra: { ao?: boolean } = {}) => {
      if (r.ktx2) loads.push({ slot, srgb, claim: null, p: cache.acquireLoaded(u, srgb), ...extra })
      else {
        const job: MapJob = slot === 'albedo' ? { kind: 'image', url: u, alpha: alphaUse, cutoff } : { kind: 'image', url: u }
        const key = slot === 'albedo' ? `i|${u}|${alphaUse}|${alphaUse === 'cutout' ? cutoff : ''}` : `i|${u}`
        loads.push({ slot, srgb, claim: key, p: cache.acquireMap(key, job, srgb, u), ...extra })
      }
    }
    if (r.albedo) url('albedo', r.albedo, true)
    if (r.normal?.kind === 'file') url('normal', r.normal.url, false)
    else if (r.normal?.kind === 'planes') {
      const key = `n|${r.normal.nx}|${r.normal.ny}`
      loads.push({ slot: 'normal', srgb: false, claim: key, p: cache.acquireMap(key, { kind: 'normal', nx: r.normal.nx, ny: r.normal.ny }, false, `${r.normal.nx} (normal)`) })
    }
    if (r.orm?.kind === 'ormh') url('orm', r.orm.url, false, { ao: true })
    else if (r.orm?.kind === 'gltf') url('orm', r.orm.url, false, { ao: r.orm.ao })
    else if (r.orm?.kind === 'planes') {
      const pl = r.orm
      const key = `o|${pl.ao ?? ''}|${pl.rough ?? ''}|${pl.metal ?? ''}|${pl.height ?? ''}|${defaults.roughness}|${defaults.metallic}`
      const job: MapJob = { kind: 'ormh', defaults }
      if (pl.ao) job.ao = pl.ao
      if (pl.rough) job.rough = pl.rough
      if (pl.metal) job.metal = pl.metal
      if (pl.height) job.height = pl.height
      loads.push({ slot: 'orm', srgb: false, ao: !!pl.ao, claim: key, p: cache.acquireMap(key, job, false, `${pl.ao ?? pl.rough ?? pl.height ?? ''} (ormh)`) })
    }
    if (r.occlusion) url('occlusion', r.occlusion, false)
    if (r.emissive) url('emissive', r.emissive, true)
    for (const l of loads) if (l.claim) applied.pending.add(`${l.srgb ? 's' : 'l'}${l.claim}`)
    const results = await Promise.allSettled(loads.map(l => l.p))
    for (const l of loads) if (l.claim) applied.pending.delete(`${l.srgb ? 's' : 'l'}${l.claim}`)
    const got = new Map<Slot, { tex: BaseTexture; ao?: boolean }>()
    const all: BaseTexture[] = []
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        got.set(loads[i]!.slot, { tex: res.value, ao: loads[i]!.ao })
        all.push(res.value)
      } else if (!(res.reason instanceof MapCancelled)) console.warn('[pbr] map failed', r.key, loads[i]!.slot, res.reason)
    })
    const giveBack = () => {
      for (const t of all) cache.release(t)
    }
    if (applied.disposed || mat.getScene().isDisposed) {
      giveBack()
      return false
    }
    if (r.albedo && !got.has('albedo')) {
      // The set is unusable (a missing or broken file): keep the retail look; a KTX2 set tries its WebP tiers.
      giveBack()
      return r.fallback ? attempt(r.fallback) : false
    }
    // Every map is in: bind them in one go (one recompile; the previous effect draws until it is ready).
    applied.textures.push(...all)
    const albedo = got.get('albedo')?.tex
    if (albedo) {
      if (r.alpha === 'albedo') {
        albedo.hasAlpha = cutout || blend
        mat.useAlphaFromAlbedoTexture = cutout || blend
      } else if ((cutout || blend) && retail) {
        mat.opacityTexture = retail
        mat.useAlphaFromAlbedoTexture = false
        alphaTestFromOpacity(mat)
      }
      albedo.level = 1
      mat.albedoTexture = albedo
    }
    const normal = got.get('normal')?.tex
    if (normal) {
      const invert = normalInvert(mat.getScene().useRightHandedSystem, r.normalGreen)
      mat.bumpTexture = normal
      normal.level = params.normalStrength ?? p.normalStrength
      mat.invertNormalMapX = invert.x
      mat.invertNormalMapY = invert.y
      mat.enableSpecularAntiAliasing = true
      applied.normal = true
    }
    const orm = got.get('orm')
    if (orm) {
      mat.metallicTexture = orm.tex
      mat.useAmbientOcclusionFromMetallicTextureRed = !!orm.ao
      mat.useRoughnessFromMetallicTextureGreen = true
      mat.useMetallnessFromMetallicTextureBlue = true
      mat.useRoughnessFromMetallicTextureAlpha = false
      mat.metallic = 1
      mat.roughness = 1
      applied.roughness = true
    }
    const occlusion = got.get('occlusion')?.tex
    if (occlusion) {
      mat.ambientTexture = occlusion
      mat.useAmbientInGrayScale = true
    }
    const emissive = got.get('emissive')?.tex
    if (emissive) {
      mat.emissiveTexture = emissive
      mat.emissiveColor.set(1, 1, 1)
    }
    if (!r.delit) mat.directIntensity = 0.8
    applied.swapped = true
    o.onChange?.()
    if (albedo && retail && retail !== mat.albedoTexture && mat.opacityTexture !== retail) {
      // For the VRAM line: the retail texture this swap lets go of (freed once no other material draws with it).
      const size = retail.getSize()
      cache.stats.retailReleased++
      cache.stats.retailBytes += size.width && size.height ? chainBytes(size.width, size.height) : 0
      if (o.onRetailFree) o.onRetailFree(retail)
      else disposeIfUnused(retail)
    }
    return true
  }
  const failed = () => {
    // The set is unusable: back to the retail look and its own defines (rare; one recompile).
    if (!applied.disposed && !applied.swapped && !mat.getScene().isDisposed) {
      releasePlaceholders(mat, held)
      applied.normal = false
      applied.roughness = false
      o.onChange?.()
    }
    return false
  }
  applied.ready = attempt(rec).then(ok => (ok ? true : failed()), err => {
    console.warn('[pbr] map set failed', rec.key, err)
    return failed()
  })
  return applied
}

/** Unbinds and releases what applyMapRecord bound (the retail textures the material borrows stay). */
export function releaseMaps(mat: Material, applied: AppliedMaps, cache: PbrTextureCache): void {
  applied.disposed = true
  const held = HELD.get(applied)
  if (held && mat instanceof PBRMaterial) {
    // Before the swap: the material goes back to its own state; after it, only a stand-in left for a map that failed.
    if (!applied.swapped) releasePlaceholders(mat, held)
    else unbindPlaceholders(mat, held)
  }
  if (mat instanceof PBRMaterial) {
    const own = new Set(applied.textures)
    if (mat.albedoTexture && own.has(mat.albedoTexture)) mat.albedoTexture = null
    if (mat.bumpTexture && own.has(mat.bumpTexture)) mat.bumpTexture = null
    if (mat.metallicTexture && own.has(mat.metallicTexture)) mat.metallicTexture = null
    if (mat.ambientTexture && own.has(mat.ambientTexture)) mat.ambientTexture = null
    if (mat.emissiveTexture && own.has(mat.emissiveTexture)) mat.emissiveTexture = null
  }
  for (const t of applied.textures) cache.release(t)
  applied.textures.length = 0
  // Maps still loading: their claims go back (an upload nobody wants is skipped); if one lands anyway, applyMapRecord
  // sees `disposed` and releases it.
  for (const k of applied.pending) cache.unwant(k.slice(1), k[0] === 's')
  applied.pending.clear()
}

/**
 * Releases a swap and puts the material back exactly as it was before applyMapRecord: the retail albedo (the caller
 * kept it alive; see ActorMaps), the flags, the colours and the intensity (W9F LG-4: the tier went back to retail in
 * the world, e.g. the preview turned off, and the actors must look as they did before wave 9).
 */
export function restoreMaps(mat: PBRMaterial, applied: AppliedMaps, cache: PbrTextureCache): void {
  const held = HELD.get(applied)
  releaseMaps(mat, applied, cache)
  if (held) releasePlaceholders(mat, held)
  const s = SNAPSHOT.get(applied)
  if (!s || mat.getScene().isDisposed) return
  mat.albedoTexture = s.albedoTexture
  if (s.albedoTexture && s.albedoHasAlpha !== null) s.albedoTexture.hasAlpha = s.albedoHasAlpha
  mat.opacityTexture = s.opacityTexture
  mat.useAlphaFromAlbedoTexture = s.useAlphaFromAlbedoTexture
  mat.bumpTexture = s.bumpTexture
  mat.invertNormalMapX = s.invertNormalMapX
  mat.invertNormalMapY = s.invertNormalMapY
  mat.enableSpecularAntiAliasing = s.enableSpecularAntiAliasing
  mat.metallicTexture = s.metallicTexture
  mat.useAmbientOcclusionFromMetallicTextureRed = s.useAmbientOcclusionFromMetallicTextureRed
  mat.useRoughnessFromMetallicTextureGreen = s.useRoughnessFromMetallicTextureGreen
  mat.useMetallnessFromMetallicTextureBlue = s.useMetallnessFromMetallicTextureBlue
  mat.useRoughnessFromMetallicTextureAlpha = s.useRoughnessFromMetallicTextureAlpha
  mat.metallic = s.metallic
  mat.roughness = s.roughness
  mat.ambientTexture = s.ambientTexture
  mat.useAmbientInGrayScale = s.useAmbientInGrayScale
  mat.emissiveTexture = s.emissiveTexture
  mat.emissiveColor.copyFrom(s.emissiveColor)
  mat.directIntensity = s.directIntensity
  applied.normal = false
  applied.roughness = false
}

// ---- actors: characters, equipment, the character screens ---------------------------------------------------------

/** The sidecar fields the actor join reads (converter SidecarMaterial). */
export interface ActorSidecar {
  materials?: Array<{ name: string; texture?: string | null }>
}

export interface ActorMapsOptions {
  /** The map sets (loaded once). */
  index: () => Promise<PbrMapIndex>
  /** The tier to load, read when a container is tracked. */
  policy: () => MapPolicy
}

/** The name the surface plugin registers under (pbr/surface-plugin.ts SRO_SURFACE_PLUGIN). */
const SURFACE_PLUGIN = 'SroSurfacePlugin'

/**
 * The progressive swap for actor glbs (characters, equipment; every scene: the character screens and the world):
 * each glTF material of a tracked container whose base texture joins a set (the sidecar's retail texture, else the
 * image name by stem) swaps its textures in place once they are in, so every instance of the container follows. On the
 * PBR path the surface plugin re-reads its roughness flag (PbrSurfaces.decorateCharacterMaterial dresses the material
 * either way).
 *
 * W9F LG-4: the retail texture leaves the container but is kept (not disposed) while the container is tracked, so
 * `refresh()` can put every material back on it when the tier becomes 'retail' in the world (the preview turned off,
 * or a live switch to Low: the pre-wave look). A tier that leaves 'retail' again re-applies the sets. The retail
 * character textures are small (retail DDJ sizes) next to the sets that replace them.
 */
export class ActorMaps {
  readonly cache: PbrTextureCache
  private readonly tracked = new Map<AssetContainer, Map<PBRMaterial, AppliedMaps>>()
  private readonly sources = new Map<AssetContainer, { glb: string; sidecar: ActorSidecar | null; retail: Set<BaseTexture> }>()
  private retailNow = false
  private disposed = false

  constructor(readonly scene: Scene, source: MapTextureSource, private readonly o: ActorMapsOptions) {
    this.cache = new PbrTextureCache(source)
  }

  /** Starts the swap for a loaded container (`glb`: its key path, `char/china/chinaman_adventurer`). Resolves with the sets started. */
  async track(container: AssetContainer, glb: string, sidecar?: ActorSidecar | null): Promise<number> {
    if (this.disposed || this.tracked.has(container)) return 0
    const applied = new Map<PBRMaterial, AppliedMaps>()
    this.tracked.set(container, applied)
    this.sources.set(container, { glb, sidecar: sidecar ?? null, retail: new Set() })
    this.retailNow = this.o.policy().tier === 'retail'
    if (this.retailNow) return 0
    return this.apply(container, applied)
  }

  private async apply(container: AssetContainer, applied: Map<PBRMaterial, AppliedMaps>): Promise<number> {
    const index = await this.o.index().catch(() => PbrMapIndex.EMPTY)
    if (this.disposed || this.tracked.get(container) !== applied || index.empty) return 0
    // Read again once the index is in: loading it installs the KTX2 transcoder when the sets ship KTX2 (Ultra).
    const policy = this.o.policy()
    if (policy.tier === 'retail') return 0
    const src = this.sources.get(container)!
    const byName = new Map<string, string>()
    for (const m of src.sidecar?.materials ?? []) if (m.texture) byName.set(m.name.toLowerCase(), m.texture)
    let n = 0
    for (const mat of container.materials) {
      if (!(mat instanceof PBRMaterial) || mat.unlit || applied.has(mat)) continue
      const image = mat.albedoTexture?.getInternalTexture()?.label || null
      if (!image) continue
      const texture = byName.get(mat.name.toLowerCase()) ?? null
      const rec = index.resolve({ glb: src.glb, image, texture, byStem: !texture }, policy)
      if (!rec) continue
      const cls: MaterialClass = rec.cls ?? (/_(face|body|hand)/i.test(image) ? 'skin' : classify(texture ?? image, { materialName: mat.name }))
      const a: AppliedMaps = applyMapRecord(mat, rec, this.cache, cls, {
        onChange: () => this.surfaceFlags(mat, a.roughness),
        onRetailFree: tex => {
          // Out of the container (it no longer draws it), kept for refresh() until untrack.
          const i = container.textures.indexOf(tex)
          if (i >= 0) container.textures.splice(i, 1)
          src.retail.add(tex)
        },
      })
      applied.set(mat, a)
      n++
    }
    return n
  }

  private surfaceFlags(mat: PBRMaterial, roughness: boolean): void {
    const pl = mat.pluginManager?.getPlugin(SURFACE_PLUGIN) as unknown as MaterialPluginLike | null
    if (pl) {
      pl.roughnessMap = roughness
      pl.refresh?.()
    }
  }

  /**
   * Re-reads the policy (the game calls it on a settings change): on 'retail' every tracked material goes back to its
   * retail state; off 'retail' again the sets are applied anew.
   */
  refresh(): void {
    if (this.disposed) return
    const retail = this.o.policy().tier === 'retail'
    if (retail === this.retailNow) return
    this.retailNow = retail
    for (const [container, applied] of [...this.tracked]) {
      if (retail) {
        for (const [mat, a] of applied) {
          restoreMaps(mat, a, this.cache)
          this.surfaceFlags(mat, false)
        }
        const src = this.sources.get(container)
        if (src) {
          // The kept retail textures belong to the container again (it disposes them with itself).
          for (const t of src.retail) if (!container.textures.includes(t)) container.textures.push(t)
          src.retail.clear()
        }
        applied.clear()
      } else {
        const fresh = new Map<PBRMaterial, AppliedMaps>()
        this.tracked.set(container, fresh)
        void this.apply(container, fresh).catch(err => console.warn('[pbr] actor maps failed', err))
      }
    }
  }

  /** Every swap of a container started so far (tests; the console). */
  applied(container: AssetContainer): ReadonlyMap<PBRMaterial, AppliedMaps> {
    return this.tracked.get(container) ?? new Map()
  }

  /** Releases a container's maps (it is being disposed). */
  untrack(container: AssetContainer): void {
    const applied = this.tracked.get(container)
    if (!applied) return
    this.tracked.delete(container)
    for (const [mat, a] of applied) releaseMaps(mat, a, this.cache)
    const src = this.sources.get(container)
    this.sources.delete(container)
    for (const t of src?.retail ?? []) disposeIfUnused(t)
  }

  dispose(): void {
    this.disposed = true
    for (const c of [...this.tracked.keys()]) this.untrack(c)
    this.cache.dispose()
  }
}

interface MaterialPluginLike {
  roughnessMap: boolean
  refresh?: () => void
}

/** A decoded result as an atlas layer: level 0 and the levels 1..n (tile-atlas.ts TileImage). */
export function tileImageOf(r: MapResult): { data: Uint8Array; levels: Uint8Array[] } {
  return { data: r.levels[0]!.data, levels: r.levels.slice(1).map(l => l.data) }
}
