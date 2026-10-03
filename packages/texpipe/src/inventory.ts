/**
 * TP-0 inventory (docs/TEXPIPE.md §1, §3.2): every unique texture the player sees, from the converted output under
 * work/out, with its key, class, alpha kind, wrap axes, importance, hero flag and texel density. A port of the
 * prototype scripts `work/tmp/texpipe/inventory.py` and `density.py`.
 *
 * Reads (never writes) work/out: the world manifest (`tiles`, `models`, `placements`), the terrain bins (texture
 * words, for tile coverage), every world and actor sidecar (`materials[].texture`, `alphaMode`, `alphaReason`,
 * `textureFormat`, `textureSize`) and the glbs beside them (TEXCOORD_0 ranges, triangle and UV areas, and the
 * embedded image of each texture). Node only.
 *
 * Scope (TEXPIPE §1.2): terrain tiles, world model textures and actor textures (characters, NPCs, mobs, equipment,
 * dropped items). UI, lightmaps, water frames, sky and effects are out of scope.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { decodeTerrainBin } from '../../convert/src/world/format.ts'
import type { WorldManifest } from '../../convert/src/world/manifest.ts'
import { classify, type MaterialClass } from '../../world-render/src/pbr/classes.ts'
import {
  checkKey, keyOf, tileKey, validateOverrides, OVERRIDES_FORMAT, OVERRIDES_VERSION,
  type AlphaKind, type TexpipeOverrides,
} from './format.ts'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')
export const OVERRIDES_FILE = join(REPO_ROOT, 'content', 'texpipe', 'overrides.json')
/** The world export the inventory reads (307 regions, the fields and the town). */
export const DEFAULT_WORLD = 'jangan-fields'
/** The town 3×3 (TEXPIPE §1.1): regions x 167..169, z 96..98. */
export const TOWN = { x0: 167, x1: 169, z0: 96, z1: 98 } as const
/** A town placement counts this many times a field placement in a world texture's importance (TEXPIPE §1.3). */
export const TOWN_WEIGHT = 4
/** The terrain hero set: the most-covering tiles (TEXPIPE §1.3: 16 tiles, 78% of the town, 72% of the fields). */
export const HERO_TILE_COUNT = 16
/**
 * An axis repeats when some triangle reaches more than this past an integer line on it (a twentieth of the texture).
 * Stricter than TEXPIPE §3.2's range test (min < −0.01 or max > 1.01): the city wall's V range is −0.988..1.020 only
 * because whole faces sit one period down, while its deepest V crossing is 0.02 (U: 23 periods) [measured].
 */
export const WRAP_EPS = 0.05
/** An OPAQUE alpha-capable texture is a specular/metal mask only if its alpha really varies (min below this). */
export const SPECMASK_ALPHA_MIN = 250

export const ACTOR_GROUPS = ['char', 'npc', 'mob', 'equipment', 'item'] as const
export type ActorGroup = (typeof ACTOR_GROUPS)[number]
export type InventoryGroup = 'tile' | 'world' | ActorGroup

export interface InventoryEntry {
  /** format.ts key: the normalised retail path, or `tile2d:<stem>`. */
  key: string
  group: InventoryGroup
  /**
   * Where the lossless decode lives, relative to work/out: a tile PNG, or the first glb that embeds the texture with
   * the glTF image index (`image`). Never work/out-opt (lossy).
   */
  source: { file: string; image?: number }
  size: [number, number]
  /** Source DDJ format (DXT1, DXT3, A8R8G8B8, ...); tiles are decoded DDJ, `null`. */
  format: string | null
  class: MaterialClass
  alpha: AlphaKind
  /** glTF alpha modes of every material that uses the texture. */
  alphaModes: string[]
  /** Minimum alpha of the embedded image, for OPAQUE alpha-capable candidates only. */
  alphaMin?: number
  /** Axes the UVs repeat along [U, V] (wrapAxes). */
  wrap: [boolean, boolean]
  /** TEXCOORD_0 range [minU, minV, maxU, maxV] over every primitive that uses the texture. */
  uvRange?: [number, number, number, number]
  /** Deepest integer-line crossing of one triangle [U, V] (wrapAxes). */
  uvCross?: [number, number]
  /** Distinct users: world models, or actor sidecars. */
  users: number
  /** World: placements of the models using it (all / town). */
  placements?: number
  townPlacements?: number
  /** Tiles: share of terrain vertices using it (all regions / town 3×3). */
  cover?: { all: number; town: number }
  /**
   * Visual importance within the group (TEXPIPE §1.3): tiles = cover.all + cover.town; world = bounding-box
   * half-surface (m²) × (placements + 4 × town placements); actors = users.
   */
  importance: number
  hero: boolean
  /** Texels per metre over the covered surface: sqrt(UV area in texels / world area). */
  pxPerM?: number
  areaM2?: number
}

export interface Inventory {
  world: string
  createdAt: string
  entries: InventoryEntry[]
  /** Non-fatal problems (unreadable sidecars, textures without size, key collisions across groups). */
  warnings: string[]
}

/** work/out, honouring `workDir` in sro.config.json when present. */
export function defaultOutDir(): string {
  const cfgPath = join(REPO_ROOT, 'sro.config.json')
  let workDir = 'work'
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { workDir?: string }
      if (cfg.workDir) workDir = cfg.workDir
    } catch {
      // A broken config is reported by the converter; the inventory falls back to work/.
    }
  }
  return join(resolve(REPO_ROOT, workDir), 'out')
}

// ---- classification rules ------------------------------------------------------------------------------------------

/** DDJ formats that carry a real alpha channel. */
const ALPHA_FORMAT = /^(DXT[2-5]|A\d+R\d+G\d+B\d+)$/i
/** The converter's default label for every OPAQUE material without the BMT alpha flag (not a detection). */
const GENERIC_MASK_REASON = /specular\/env mask/i
/** `equipment/materials.ts`'s measured verdict: "BMT alpha flag but N% … the alpha is a mask". */
const EQUIPMENT_MASK_REASON = /the alpha is a mask/i

export interface AlphaFacts {
  alphaModes: Iterable<string>
  alphaReasons: Iterable<string>
  format: string | null
  /** Minimum alpha of the image (undefined: not decoded). */
  alphaMin?: number
}

/**
 * True when the texture needs its alpha decoded to tell `specmask` from the other kinds: an alpha-capable format
 * and either the equipment verdict (which outranks the generic BLEND the drop-item copy of the same texture gets:
 * the Copper Sword is OPAQUE in `equipment/` and BLEND in `item/`), or OPAQUE in every use with the generic label.
 */
export function isSpecmaskCandidate(f: Omit<AlphaFacts, 'alphaMin'>): boolean {
  if (!ALPHA_FORMAT.test(f.format ?? '')) return false
  const reasons = [...f.alphaReasons]
  if (reasons.some(r => EQUIPMENT_MASK_REASON.test(r))) return true
  const modes = [...f.alphaModes]
  return modes.length > 0 && modes.every(m => m === 'OPAQUE') && reasons.some(r => GENERIC_MASK_REASON.test(r))
}

/**
 * The alpha kind (TEXPIPE §3.2, with the fact-check's corrected specmask rule): a specmask candidate whose alpha
 * really varies (min < 250) → specmask; else any BLEND use → blend, any MASK use → cutout; otherwise none.
 */
export function alphaKind(f: AlphaFacts): AlphaKind {
  if (isSpecmaskCandidate(f) && f.alphaMin !== undefined && f.alphaMin < SPECMASK_ALPHA_MIN) return 'specmask'
  const modes = new Set(f.alphaModes)
  if (modes.has('BLEND')) return 'blend'
  if (modes.has('MASK')) return 'cutout'
  return 'none'
}

/** Wrap axes from the deepest per-triangle integer crossing [U, V] (primitiveStats `cross`). */
export function wrapAxes(cross: readonly [number, number] | undefined): [boolean, boolean] {
  if (!cross) return [false, false]
  return [cross[0] > WRAP_EPS, cross[1] > WRAP_EPS]
}

/**
 * The world hero set (TEXPIPE §1.3), matched on the texture key: the city-wall set (`jangan_enter/cj_*`), the palace
 * (`cj_pal_*`) and the town gate (`cj_jang_gate*`), the most-placed tree species and `stone_clif01`.
 */
export const HERO_WORLD: readonly RegExp[] = [
  /\/jangan_enter\/cj_/,
  /\/cj_pal_/,
  /\/cj_jang_gate/,
  /\/tre_pine0[78]_/,
  /\/tre_bam04_/,
  /\/tre_tree0[29]_/,
  /\/tre_bank_/,
  /\/tre_willow03_/,
  /\/stone_clif01/,
]

/** The actor hero set: every player character atlas, the starter outfits and the degree-1 starter weapons. */
export const HERO_ACTOR_SIDECAR: readonly RegExp[] = [
  /^char\//,
  /\/(man|woman)_item\/clothes_01_/,
  /\/weapon\/(sword|blade|spear|bow|tblade)_01\.json$/,
]

/** TEXPIPE §7.1: the 13 test textures plus the second paving tile, as key suffixes (each must match one entry). */
export const TEST_SET: readonly string[] = [
  'tile2d:c_marble_jang_09',
  'tile2d:c_grass_fld_03',
  'tile2d:c_grass_hmfld_01',
  'tile2d:c_dust_fld_01',
  'tile2d:c_stone_hmfld_01',
  '/jangan_enter/cj_wall01.ddj',
  '/cj_pal_roof.ddj',
  '/tre_bank_pilla.ddj',
  '/tre_tree02_01.ddj',
  '/man_item/clothes_01_ba.ddj',
  '/man/chinaman_adventurer_body.ddj',
  '/man/chinaman_adventurer_hair.ddj',
  '/weapon/sword1_2_3.ddj',
  'tile2d:c_marble_jang_04',
]

export type SetName = 'test' | 'hero' | 'all'

/** The entries of a named batch (`pnpm texpipe run --set test|hero|all`). */
export function selectSet(inv: Inventory, set: SetName): InventoryEntry[] {
  if (set === 'all') return inv.entries
  if (set === 'hero') return inv.entries.filter(e => e.hero)
  return TEST_SET.flatMap(s => inv.entries.filter(e => e.key.endsWith(s)).slice(0, 1))
}

// ---- glb reading ------------------------------------------------------------------------------------------------------

interface GltfJson {
  meshes?: Array<{ name?: string; primitives: Array<{ attributes: Record<string, number>; indices?: number; material?: number; mode?: number }> }>
  materials?: Array<{ name?: string; pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }>
  textures?: Array<{ source?: number }>
  images?: Array<{ name?: string; bufferView?: number; mimeType?: string }>
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }>
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>
}

export interface Glb {
  json: GltfJson
  bin: Uint8Array
}

/** Splits a binary glTF into its JSON and BIN chunks. */
export function parseGlb(bytes: Uint8Array): Glb {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('glb: bad magic')
  const jsonLen = dv.getUint32(12, true)
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('glb: first chunk is not JSON')
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))) as GltfJson
  let bin: Uint8Array = new Uint8Array(0)
  const binAt = 20 + jsonLen
  if (binAt + 8 <= bytes.byteLength && dv.getUint32(binAt + 4, true) === 0x004e4942) {
    bin = bytes.subarray(binAt + 8, binAt + 8 + dv.getUint32(binAt, true))
  }
  return { json, bin }
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
const COMPONENT_READ: Record<number, [bytes: number, read: (dv: DataView, o: number) => number, normMax: number]> = {
  5120: [1, (dv, o) => dv.getInt8(o), 127],
  5121: [1, (dv, o) => dv.getUint8(o), 255],
  5122: [2, (dv, o) => dv.getInt16(o, true), 32767],
  5123: [2, (dv, o) => dv.getUint16(o, true), 65535],
  5125: [4, (dv, o) => dv.getUint32(o, true), 1],
  5126: [4, (dv, o) => dv.getFloat32(o, true), 1],
}

/** An accessor as a flat Float64Array (count × components), honouring byteStride and `normalized`. */
export function readAccessor(glb: Glb, index: number): { data: Float64Array; n: number; count: number } {
  const a = glb.json.accessors?.[index]
  if (!a) throw new Error(`glb: no accessor ${index}`)
  const n = COMPONENTS[a.type]
  const comp = COMPONENT_READ[a.componentType]
  if (!n || !comp) throw new Error(`glb: unsupported accessor ${a.type}/${a.componentType}`)
  const data = new Float64Array(a.count * n)
  if (a.bufferView === undefined) return { data, n, count: a.count }
  const bv = glb.json.bufferViews![a.bufferView]!
  const [size, read, normMax] = comp
  const stride = bv.byteStride || size * n
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
  const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength)
  const scale = a.normalized ? 1 / normMax : 1
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < n; c++) data[i * n + c] = read(dv, base + i * stride + c * size) * scale
  }
  return { data, n, count: a.count }
}

/** The bytes of a glTF image stored in a buffer view (undefined for external URIs). */
export function glbImage(glb: Glb, image: number): Uint8Array | undefined {
  const img = glb.json.images?.[image]
  if (img?.bufferView === undefined) return undefined
  const bv = glb.json.bufferViews![img.bufferView]!
  return glb.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
}

/** The glTF image index of a material's base colour texture. */
function materialImage(glb: Glb, material: number): number | undefined {
  const t = glb.json.materials?.[material]?.pbrMetallicRoughness?.baseColorTexture?.index
  return t === undefined ? undefined : glb.json.textures?.[t]?.source
}

/**
 * Per primitive of one material: TEXCOORD_0 range, the deepest crossing of an integer line by one triangle per axis
 * (see wrapAxes), triangle area (m²) and UV area (unit square).
 */
export interface PrimitiveStats {
  material: number
  uvRange: [number, number, number, number] | null
  cross: [number, number]
  worldArea: number
  uvArea: number
}

/** How far a span [lo, hi] reaches past an integer line on its nearer side (0 when it crosses none). */
export function crossDepth(lo: number, hi: number): number {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0
  // min(k − lo, hi − k) peaks at the midpoint, so the integer nearest to it (inside the span) is the deepest.
  const k = Math.min(Math.floor(hi), Math.max(Math.ceil(lo), Math.round((lo + hi) / 2)))
  return k >= lo && k <= hi ? Math.min(k - lo, hi - k) : 0
}

export function primitiveStats(glb: Glb): PrimitiveStats[] {
  const out: PrimitiveStats[] = []
  for (const mesh of glb.json.meshes ?? []) {
    for (const pr of mesh.primitives) {
      if (pr.material === undefined || (pr.mode !== undefined && pr.mode !== 4)) continue
      const uvAt = pr.attributes.TEXCOORD_0
      if (uvAt === undefined) {
        out.push({ material: pr.material, uvRange: null, cross: [0, 0], worldArea: 0, uvArea: 0 })
        continue
      }
      const uvAcc = readAccessor(glb, uvAt)
      const uv = uvAcc.data
      let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity
      for (let i = 0; i < uv.length; i += 2) {
        const u = uv[i]!, v = uv[i + 1]!
        if (u < minU) minU = u
        if (u > maxU) maxU = u
        if (v < minV) minV = v
        if (v > maxV) maxV = v
      }
      const idx = pr.indices !== undefined ? readAccessor(glb, pr.indices).data : Float64Array.from({ length: uvAcc.count }, (_, i) => i)
      const P = pr.attributes.POSITION !== undefined ? readAccessor(glb, pr.attributes.POSITION).data : null
      const cross: [number, number] = [0, 0]
      let worldArea = 0, uvArea = 0
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!
        for (let ax = 0; ax < 2; ax++) {
          const ua = uv[a * 2 + ax]!, ub = uv[b * 2 + ax]!, uc = uv[c * 2 + ax]!
          const d = crossDepth(Math.min(ua, ub, uc), Math.max(ua, ub, uc))
          if (d > cross[ax]!) cross[ax] = d
        }
        const du1 = uv[b * 2]! - uv[a * 2]!, dv1 = uv[b * 2 + 1]! - uv[a * 2 + 1]!
        const du2 = uv[c * 2]! - uv[a * 2]!, dv2 = uv[c * 2 + 1]! - uv[a * 2 + 1]!
        uvArea += 0.5 * Math.abs(du1 * dv2 - du2 * dv1)
        if (!P) continue
        const abx = P[b * 3]! - P[a * 3]!, aby = P[b * 3 + 1]! - P[a * 3 + 1]!, abz = P[b * 3 + 2]! - P[a * 3 + 2]!
        const acx = P[c * 3]! - P[a * 3]!, acy = P[c * 3 + 1]! - P[a * 3 + 1]!, acz = P[c * 3 + 2]! - P[a * 3 + 2]!
        const cx = aby * acz - abz * acy, cy = abz * acx - abx * acz, cz = abx * acy - aby * acx
        worldArea += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz)
      }
      out.push({ material: pr.material, uvRange: uv.length ? [minU, minV, maxU, maxV] : null, cross, worldArea, uvArea })
    }
  }
  return out
}

// ---- the scan ---------------------------------------------------------------------------------------------------------

/** The sidecar fields the inventory reads (gltf/convert.ts SidecarMaterial). */
interface SidecarMaterialLite {
  name: string
  texture: string | null
  textureFormat?: string
  textureSize?: [number, number]
  alphaMode: string
  alphaReason: string
}

interface Acc {
  key: string
  group: InventoryGroup
  source: { file: string; image?: number }
  size: [number, number] | null
  format: string | null
  alphaModes: Set<string>
  alphaReasons: Set<string>
  materialNames: Set<string>
  users: Set<string>
  placements: number
  townPlacements: number
  importance: number
  uvRange: [number, number, number, number] | null
  cross: [number, number]
  worldArea: number
  uvTexels: number
  hero: boolean
}

export interface InventoryOptions {
  /** work/out (default: defaultOutDir()). */
  outDir?: string
  /** World export folder under world/ (default jangan-fields). */
  world?: string
  /** Decode the embedded images of specmask candidates (default true; false = those become `none`). */
  decodeAlpha?: boolean
  /** Overrides (default: content/texpipe/overrides.json when present). */
  overrides?: TexpipeOverrides | null
}

const isTown = (x: number, z: number) => x >= TOWN.x0 && x <= TOWN.x1 && z >= TOWN.z0 && z <= TOWN.z1

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Reads content/texpipe/overrides.json (null when absent); throws on an invalid file. */
export function loadOverrides(path = OVERRIDES_FILE): TexpipeOverrides | null {
  if (!existsSync(path)) return null
  const o = readJson<unknown>(path)
  const errors = validateOverrides(o)
  if (errors.length) throw new Error(`${path}:\n  ${errors.join('\n  ')}`)
  return o as TexpipeOverrides
}

/** Walks `dir` for sidecar JSONs (skipping `_anims` folders and index files). */
function sidecarFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) {
        if (!ent.name.includes('_anims')) walk(p)
      } else if (ent.name.endsWith('.json') && ent.name !== 'equipment.json' && !ent.name.endsWith('index.json')) out.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}

const rel = (outDir: string, p: string) => p.slice(outDir.length + 1).replace(/\\/g, '/')

/** Builds the inventory. Throws when the world manifest is missing. */
export async function buildInventory(opts: InventoryOptions = {}): Promise<Inventory> {
  const outDir = resolve(opts.outDir ?? defaultOutDir())
  const world = opts.world ?? DEFAULT_WORLD
  const worldDir = join(outDir, 'world', world)
  const manifestPath = join(worldDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`no world export at ${manifestPath} (run pnpm sro convert-region --preset ${world})`)
  const man = readJson<WorldManifest>(manifestPath)
  const warnings: string[] = []
  const accs = new Map<string, Acc>()
  const glbCache = new Map<string, Glb | null>()
  const loadGlb = (path: string): Glb | null => {
    if (!glbCache.has(path)) {
      let g: Glb | null = null
      try {
        if (existsSync(path)) g = parseGlb(readFileSync(path))
      } catch (e) {
        warnings.push(`${rel(outDir, path)}: ${(e as Error).message}`)
      }
      glbCache.set(path, g)
    }
    return glbCache.get(path)!
  }

  // Terrain tiles: vertex coverage over every region and over the town (texture word & 0x3ff = tile2d id). The coast's
  // synthetic regions (open sea and beach filler beyond the export, docs/COAST.md §9.1) are left out: they are not
  // ground anyone walks on. The coast's repaint of the ring still shifts the ranking, so the reviewed overrides pin the
  // TEXPIPE §1.3 hero tiles (content/texpipe/overrides.json).
  const coverAll = new Map<number, number>()
  const coverTown = new Map<number, number>()
  let totAll = 0, totTown = 0
  for (const r of man.regions) {
    if (r.synthetic) continue
    const bin = decodeTerrainBin(readFileSync(join(worldDir, r.terrain.file)))
    const town = isTown(r.x, r.z)
    for (const w of bin.textures) {
      const id = w & 0x3ff
      coverAll.set(id, (coverAll.get(id) ?? 0) + 1)
      totAll++
      if (town) {
        coverTown.set(id, (coverTown.get(id) ?? 0) + 1)
        totTown++
      }
    }
  }
  const tileEntries: InventoryEntry[] = []
  for (const t of man.tiles) {
    const key = tileKey(t.source)
    const cover = { all: (coverAll.get(t.id) ?? 0) / (totAll || 1), town: (coverTown.get(t.id) ?? 0) / (totTown || 1) }
    tileEntries.push({
      key, group: 'tile', source: { file: `world/${world}/${t.file}` }, size: [t.width, t.height], format: null,
      class: classify(key, { tileType: t.typeName ?? undefined }), alpha: 'none', alphaModes: [], wrap: [true, true],
      users: 1, cover, importance: cover.all + cover.town, hero: false,
    })
  }
  tileEntries.sort((a, b) => b.importance - a.importance)
  tileEntries.slice(0, HERO_TILE_COUNT).forEach(e => { e.hero = true })

  const touch = (tex: string, group: InventoryGroup, mat: SidecarMaterialLite, user: string): Acc => {
    const key = keyOf(tex)
    let a = accs.get(key)
    if (!a) {
      a = {
        key, group, source: { file: '' }, size: mat.textureSize ?? null, format: mat.textureFormat ?? null,
        alphaModes: new Set(), alphaReasons: new Set(), materialNames: new Set(), users: new Set(),
        placements: 0, townPlacements: 0, importance: 0, uvRange: null, cross: [0, 0], worldArea: 0, uvTexels: 0, hero: false,
      }
      accs.set(key, a)
    } else if (a.group !== group && (a.group === 'world' || group === 'world') && !a.users.has(user)) {
      warnings.push(`${key}: used by ${a.group} and ${group} (kept as ${a.group})`)
    }
    a.alphaModes.add(mat.alphaMode)
    if (mat.alphaReason) a.alphaReasons.add(mat.alphaReason)
    a.materialNames.add(mat.name)
    if (!a.size && mat.textureSize) a.size = mat.textureSize
    if (!a.format && mat.textureFormat) a.format = mat.textureFormat
    return a
  }

  /** Joins a glb's primitives to the sidecar textures (by material name) and accumulates UV range and areas. */
  const scanGeometry = (glbPath: string, byName: Map<string, SidecarMaterialLite>) => {
    const glb = loadGlb(glbPath)
    if (!glb) return
    const file = rel(outDir, glbPath)
    for (const s of primitiveStats(glb)) {
      const name = glb.json.materials?.[s.material]?.name
      const mat = name !== undefined ? byName.get(name.toLowerCase()) : undefined
      if (!mat?.texture) continue
      const a = accs.get(keyOf(mat.texture))
      if (!a) continue
      if (!a.source.file) {
        const image = materialImage(glb, s.material)
        if (image !== undefined) a.source = { file, image }
      }
      if (s.uvRange) {
        const r = a.uvRange
        a.uvRange = r
          ? [Math.min(r[0], s.uvRange[0]), Math.min(r[1], s.uvRange[1]), Math.max(r[2], s.uvRange[2]), Math.max(r[3], s.uvRange[3])]
          : [...s.uvRange]
      }
      a.cross = [Math.max(a.cross[0], s.cross[0]), Math.max(a.cross[1], s.cross[1])]
      a.worldArea += s.worldArea
      if (a.size) a.uvTexels += s.uvArea * a.size[0] * a.size[1]
    }
  }

  // World models: placements (all / town) per model, then every textured material of every model.
  const placed = new Map<number, number>()
  const placedTown = new Map<number, number>()
  for (const p of man.placements) {
    const town = isTown(p.region & 0xff, (p.region >> 8) & 0x7f)
    for (const mi of p.models) {
      placed.set(mi, (placed.get(mi) ?? 0) + 1)
      if (town) placedTown.set(mi, (placedTown.get(mi) ?? 0) + 1)
    }
  }
  for (const m of man.models) {
    if (!m.sidecar || !m.glb) continue
    const scPath = join(worldDir, m.sidecar)
    if (!existsSync(scPath)) continue
    let materials: SidecarMaterialLite[]
    try {
      materials = readJson<{ materials?: SidecarMaterialLite[] }>(scPath).materials ?? []
    } catch (e) {
      warnings.push(`${m.sidecar}: ${(e as Error).message}`)
      continue
    }
    const ext = [0, 1, 2].map(i => m.boundsMax[i]! - m.boundsMin[i]!)
    const surface = ext[0]! * ext[1]! + ext[1]! * ext[2]! + ext[0]! * ext[2]!
    const pl = placed.get(m.index) ?? 0, tw = placedTown.get(m.index) ?? 0
    const byName = new Map<string, SidecarMaterialLite>()
    for (const mat of materials) {
      byName.set(mat.name.toLowerCase(), mat)
      if (!mat.texture) continue
      const user = `model:${m.index}`
      const a = touch(mat.texture, 'world', mat, user)
      if (!a.users.has(user)) {
        a.users.add(user)
        a.placements += pl
        a.townPlacements += tw
        a.importance += surface * (pl + TOWN_WEIGHT * tw)
      }
    }
    scanGeometry(join(worldDir, m.glb), byName)
  }

  // Actors: every sidecar under char/, npc/, mob/, equipment/, item/ (and the glb beside it).
  for (const group of ACTOR_GROUPS) {
    for (const scPath of sidecarFiles(join(outDir, group))) {
      let sc: unknown
      try {
        sc = readJson<unknown>(scPath)
      } catch {
        continue
      }
      const materials = (sc as { materials?: unknown }).materials
      if (typeof sc !== 'object' || sc === null || !Array.isArray(materials)) continue
      const scRel = rel(outDir, scPath)
      const hero = HERO_ACTOR_SIDECAR.some(r => r.test(scRel))
      const byName = new Map<string, SidecarMaterialLite>()
      for (const mat of materials as SidecarMaterialLite[]) {
        byName.set(mat.name.toLowerCase(), mat)
        if (!mat.texture) continue
        const a = touch(mat.texture, group, mat, scRel)
        if (!a.users.has(scRel)) {
          a.users.add(scRel)
          a.importance++
        }
        if (hero) a.hero = true
      }
      scanGeometry(scPath.replace(/\.json$/, '.glb'), byName)
    }
  }

  // Alpha: decode the embedded images of the OPAQUE alpha-capable candidates only.
  const alphaMins = new Map<string, number>()
  if (opts.decodeAlpha !== false) {
    for (const a of accs.values()) {
      if (!isSpecmaskCandidate(a) || a.source.image === undefined) continue
      const glb = loadGlb(join(outDir, a.source.file))
      const bytes = glb ? glbImage(glb, a.source.image) : undefined
      if (!bytes) continue
      try {
        const img = sharp(bytes)
        const meta = await img.metadata()
        alphaMins.set(a.key, meta.hasAlpha ? (await img.stats()).channels[3]!.min : 255)
      } catch (e) {
        warnings.push(`${a.key}: alpha decode failed: ${(e as Error).message}`)
      }
    }
  }

  const entries: InventoryEntry[] = [...tileEntries]
  for (const a of accs.values()) {
    if (!a.size) warnings.push(`${a.key}: no textureSize in its sidecars`)
    if (!a.source.file) warnings.push(`${a.key}: no glb primitive embeds it`)
    const alphaMin = alphaMins.get(a.key)
    const modes = [...a.alphaModes].sort()
    const e: InventoryEntry = {
      key: a.key,
      group: a.group,
      source: a.source,
      size: a.size ?? [0, 0],
      format: a.format,
      class: classify(a.key, {
        alphaMode: (a.alphaModes.has('MASK') ? 'MASK' : a.alphaModes.has('BLEND') ? 'BLEND' : 'OPAQUE'),
        materialName: [...a.materialNames][0],
      }),
      alpha: alphaKind({ alphaModes: a.alphaModes, alphaReasons: a.alphaReasons, format: a.format, alphaMin }),
      alphaModes: modes,
      wrap: wrapAxes(a.cross),
      users: a.users.size,
      importance: a.importance,
      hero: a.hero || (a.group === 'world' && HERO_WORLD.some(r => r.test(a.key))),
    }
    if (alphaMin !== undefined) e.alphaMin = alphaMin
    if (a.uvRange) {
      e.uvRange = a.uvRange.map(v => Math.round(v * 1e4) / 1e4) as [number, number, number, number]
      e.uvCross = a.cross.map(v => Math.round(v * 1e4) / 1e4) as [number, number]
    }
    if (a.group === 'world') {
      e.placements = a.placements
      e.townPlacements = a.townPlacements
    }
    if (a.worldArea > 0) {
      e.pxPerM = Math.round(Math.sqrt(a.uvTexels / a.worldArea) * 10) / 10
      e.areaM2 = Math.round(a.worldArea * 10) / 10
    }
    entries.push(e)
  }

  for (const e of entries) {
    const bad = checkKey(e.key)
    if (bad) warnings.push(`${e.key}: ${bad}`)
  }
  applyOverrides(entries, opts.overrides === undefined ? loadOverrides() : opts.overrides, warnings)
  return { world, createdAt: new Date().toISOString(), entries, warnings }
}

/** Applies the reviewed `class`, `hero`, `alpha` and `wrap` corrections; unknown keys become warnings. */
export function applyOverrides(entries: InventoryEntry[], o: TexpipeOverrides | null, warnings: string[] = []): void {
  if (!o) return
  const byKey = new Map(entries.map(e => [e.key, e]))
  for (const [key, v] of Object.entries(o.sets)) {
    const e = byKey.get(key)
    if (!e) {
      warnings.push(`overrides: ${key} is not in the inventory`)
      continue
    }
    if (v.class) e.class = v.class
    if (v.hero !== undefined) e.hero = v.hero
    if (v.alpha) e.alpha = v.alpha
    if (v.wrap) e.wrap = [...v.wrap]
  }
}

/** An empty overrides file (content/texpipe/overrides.json). */
export function emptyOverrides(): TexpipeOverrides {
  return { format: OVERRIDES_FORMAT, version: OVERRIDES_VERSION, sets: {} }
}

// ---- summary ------------------------------------------------------------------------------------------------------------

export interface GroupTotals {
  textures: number
  mpx: number
}

export interface InventorySummary {
  total: GroupTotals
  groups: Record<InventoryGroup, GroupTotals>
  hero: GroupTotals
  /** World textures sampled outside [0, 1] on at least one axis / with geometry. */
  worldWrapping: number
  worldWithGeometry: number
  /** World px per metre: per texture and weighted by covered surface (p10, p50, p90). */
  worldPxPerM: { byTexture: [number, number, number]; bySurface: [number, number, number] }
}

const texels = (e: InventoryEntry) => e.size[0] * e.size[1]

function percentiles(values: number[], weights: number[] | null, ps: number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!)
  if (!order.length) return ps.map(() => 0)
  if (!weights) return ps.map(p => values[order[Math.min(order.length - 1, Math.floor(p * order.length))]!]!)
  const total = weights.reduce((s, w) => s + w, 0)
  return ps.map(p => {
    let acc = 0
    for (const i of order) {
      acc += weights[i]!
      if (acc >= p * total) return values[i]!
    }
    return values[order[order.length - 1]!]!
  })
}

export function summarize(inv: Inventory): InventorySummary {
  const groups = {} as Record<InventoryGroup, GroupTotals>
  for (const g of ['tile', 'world', ...ACTOR_GROUPS] as InventoryGroup[]) groups[g] = { textures: 0, mpx: 0 }
  const total = { textures: 0, mpx: 0 }, hero = { textures: 0, mpx: 0 }
  for (const e of inv.entries) {
    const mpx = texels(e) / 1e6
    groups[e.group].textures++
    groups[e.group].mpx += mpx
    total.textures++
    total.mpx += mpx
    if (e.hero) {
      hero.textures++
      hero.mpx += mpx
    }
  }
  const world = inv.entries.filter(e => e.group === 'world' && e.pxPerM !== undefined)
  const d = world.map(e => e.pxPerM!)
  const [b0, b1, b2] = percentiles(d, null, [0.1, 0.5, 0.9]) as [number, number, number]
  const [s0, s1, s2] = percentiles(d, world.map(e => e.areaM2 ?? 0), [0.1, 0.5, 0.9]) as [number, number, number]
  return {
    total, groups, hero,
    worldWrapping: world.filter(e => e.wrap[0] || e.wrap[1]).length,
    worldWithGeometry: world.length,
    worldPxPerM: { byTexture: [b0, b1, b2], bySurface: [s0, s1, s2] },
  }
}

const hist = (items: readonly string[]) => {
  const m = new Map<string, number>()
  for (const s of items) m.set(s, (m.get(s) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')
}

/** The printed report of `pnpm texpipe inventory` (TEXPIPE §1.1 totals first). */
export function formatInventory(inv: Inventory, top = 12): string {
  const s = summarize(inv)
  const f = (t: GroupTotals) => `${String(t.textures).padStart(5)} textures ${t.mpx.toFixed(1).padStart(6)} Mpx`
  const lines = [`Texture inventory of work/out (world ${inv.world})`, '']
  const label: Record<InventoryGroup, string> = {
    tile: 'Terrain tiles', world: 'World models', char: 'Characters', npc: 'NPCs', mob: 'Mobs', equipment: 'Equipment', item: 'Items',
  }
  for (const [g, t] of Object.entries(s.groups) as [InventoryGroup, GroupTotals][]) lines.push(`  ${label[g].padEnd(14)} ${f(t)}`)
  lines.push(`  ${'Total'.padEnd(14)} ${f(s.total)}`, `  ${'Hero set'.padEnd(14)} ${f(s.hero)}`, '')
  const world = inv.entries.filter(e => e.group === 'world')
  lines.push(`World formats:  ${hist(world.map(e => e.format ?? '?'))}`)
  lines.push(`Alpha kinds:    ${hist(inv.entries.map(e => e.alpha))}`)
  lines.push(`Classes:        ${hist(inv.entries.map(e => e.class))}`)
  lines.push(`World wrapping: ${s.worldWrapping} of ${s.worldWithGeometry} with geometry repeat on at least one axis`)
  const [b0, b1, b2] = s.worldPxPerM.byTexture, [s0, s1, s2] = s.worldPxPerM.bySurface
  lines.push(`World px/m:     per texture p10/p50/p90 ${b0.toFixed(0)}/${b1.toFixed(0)}/${b2.toFixed(0)}, ` +
    `by covered surface ${s0.toFixed(0)}/${s1.toFixed(0)}/${s2.toFixed(0)}`)
  const tiles = inv.entries.filter(e => e.group === 'tile')
  lines.push('', `Hero tiles (${tiles.filter(e => e.hero).length}):`)
  for (const e of tiles.filter(t => t.hero)) {
    lines.push(`  ${e.key.padEnd(28)} ${e.class.padEnd(13)} all ${(e.cover!.all * 100).toFixed(1).padStart(5)}%  town ${(e.cover!.town * 100).toFixed(1).padStart(5)}%`)
  }
  lines.push('', `Top ${top} world textures by importance:`)
  for (const e of [...world].sort((a, b) => b.importance - a.importance).slice(0, top)) {
    lines.push(`  ${e.key.slice(-58).padEnd(58)} ${e.size.join('x').padEnd(8)} ${e.class.padEnd(10)} ${e.alpha.padEnd(8)} ` +
      `wrap ${e.wrap[0] ? 'U' : '-'}${e.wrap[1] ? 'V' : '-'} pl ${String(e.placements).padStart(4)} town ${String(e.townPlacements).padStart(3)}${e.hero ? ' hero' : ''}`)
  }
  if (inv.warnings.length) {
    lines.push('', `${inv.warnings.length} warnings:`)
    for (const w of inv.warnings.slice(0, 10)) lines.push(`  ! ${w}`)
    if (inv.warnings.length > 10) lines.push(`  ... (all in the JSON)`)
  }
  return lines.join('\n')
}
