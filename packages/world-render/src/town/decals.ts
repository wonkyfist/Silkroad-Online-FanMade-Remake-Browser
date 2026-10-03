/**
 * The town's ground decals and its pond (docs/TOWN_LIFE.md §7.4, §7.5; docs/WAVE_PLAN7.md D5, D18; lane TL-B).
 *
 * - **Decals** (dirt at the gates and stall fronts, moss at the walls' feet, puddles): the converter's dressing pass
 *   resolves each decal of `content/town/<town>-dressing.json` onto its ground (flat paving only) and writes
 *   `town-decals.json` beside the manifest (packages/convert/src/world/town/dressing.ts). Here they are flat quads
 *   lifted LIFT_M over that ground, merged into **one mesh** (dirt and moss; one draw) with one procedural atlas
 *   (`decalAtlas`, 2 × 2 cells), plus a second mesh for the puddles that only draws while the weather has puddles
 *   (`wxA.y`, the wave-9 puddle level; its texture fades with it). The material multiplies the frame below it
 *   (ALPHA_MULTIPLY: white = unchanged), so a decal darkens and tints whatever light the paving has, day or night, and
 *   needs no lighting of its own. StandardMaterial, no plugin: Babylon's own GLSL and WGSL (no parity code here), one
 *   sampler. Meshes carry the 'town' tag (the batcher never takes them), are not pickable, cast and take no shadow.
 * - **The pond**: the dressing file's `pond` profile (turbid colour, reflection) through W11-S's water seam:
 *   `WaterRenderer.setProfile('town', …)` and `setProfileLookup(region → 'town')` (water.ts; nobody edits it, D5).
 *   Disposing clears both, so the water is today's again.
 *
 * Medium and up only: the town part (World.town) is made on the PBR path only, and `attachTownDressing` is called by
 * it (town/index.ts; TL-C / I-11 wire the call). On Low / Classic nothing here exists (the Low guard).
 */
import {
  Color3,
  Constants,
  Mesh,
  RawTexture,
  StandardMaterial,
  Texture,
  VertexData,
  type AbstractMesh,
  type Scene,
} from '@babylonjs/core'
import type { TownDressingFile, TownPondProfile } from '../../../shared/src/town.ts'
import type { WaterProfile, WaterProfileId } from '../pbr/water-town-plugin.ts'
import { TOWN_TAG, type TownHost } from './types.ts'

/** The resolved decals beside the manifest (packages/convert/src/world/town/dressing.ts TOWN_DECALS_FILE). */
export const TOWN_DECALS_FILE = 'town-decals.json'
export const TOWN_DECALS_FORMAT = 'sro-town-decals'
/** Decals a region may hold (TOWN_LIFE §7.4; the converter enforces it, the reader too). */
export const DECALS_PER_REGION = 40
/** Height of a decal over its resolved ground (m), plus the material's depth offset. */
export const LIFT_M = 0.03
/** The atlas: 2 × 2 cells (dirt, moss / puddle, spare), RGBA8. */
export const DECAL_ATLAS_SIZE = 256
/** Puddle level (wxA.y) below which the puddle mesh does not draw; changes smaller than PUDDLE_STEP keep the texture. */
export const PUDDLE_MIN = 0.02
export const PUDDLE_STEP = 0.05

export type TownDecalKind = 'dirt' | 'moss' | 'puddle'

export interface TownDecalRow {
  kind: TownDecalKind
  x: number
  y: number
  z: number
  yaw: number
  size: [number, number]
  region: number
}

const KINDS: readonly TownDecalKind[] = ['dirt', 'moss', 'puddle']
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Reads `town-decals.json` (tolerant: bad rows are dropped; at most DECALS_PER_REGION a region, in file order). */
export function readTownDecals(json: unknown): TownDecalRow[] {
  const j = json as { format?: unknown; decals?: unknown } | null
  if (!j || j.format !== TOWN_DECALS_FORMAT || !Array.isArray(j.decals)) return []
  const out: TownDecalRow[] = []
  const per = new Map<number, number>()
  for (const d of j.decals as Array<Record<string, unknown>>) {
    if (!d || !KINDS.includes(d.kind as TownDecalKind) || !isNum(d.x) || !isNum(d.y) || !isNum(d.z) || !isNum(d.yaw)) continue
    const s = d.size as unknown[]
    if (!Array.isArray(s) || s.length !== 2 || !isNum(s[0]) || !isNum(s[1]) || s[0] <= 0 || s[1] <= 0) continue
    const region = isNum(d.region) ? d.region : -1
    const n = per.get(region) ?? 0
    if (n >= DECALS_PER_REGION) continue
    per.set(region, n + 1)
    out.push({ kind: d.kind as TownDecalKind, x: d.x, y: d.y, z: d.z, yaw: d.yaw, size: [s[0], s[1]], region })
  }
  return out
}

/** The atlas cell (u0, v0) of a kind (each cell is half the atlas). */
function cellOf(kind: TownDecalKind): [number, number] {
  return kind === 'dirt' ? [0, 0] : kind === 'moss' ? [0.5, 0] : [0, 0.5]
}

/**
 * Flat quads for `rows` (glTF metres): each decal a rectangle of `size` turned by its yaw (+yaw about +Y), at its
 * ground + LIFT_M, facing up, its cell's UVs (mirrored on every other decal so repeats differ).
 */
export function decalQuads(rows: readonly TownDecalRow[]): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array } {
  const n = rows.length
  const positions = new Float32Array(n * 12)
  const normals = new Float32Array(n * 12)
  const uvs = new Float32Array(n * 8)
  const indices = new Uint32Array(n * 6)
  const inset = 1 / DECAL_ATLAS_SIZE
  rows.forEach((d, i) => {
    const c = Math.cos(d.yaw)
    const s = Math.sin(d.yaw)
    const hx = d.size[0] / 2
    const hz = d.size[1] / 2
    const [u0, v0] = cellOf(d.kind)
    const flip = i % 2 === 1
    const corners: Array<[number, number, number, number]> = [[-hx, -hz, 0, 0], [hx, -hz, 1, 0], [hx, hz, 1, 1], [-hx, hz, 0, 1]]
    corners.forEach(([lx, lz, cu, cv], k) => {
      positions.set([d.x + lx * c + lz * s, d.y + LIFT_M, d.z - lx * s + lz * c], i * 12 + k * 3)
      normals.set([0, 1, 0], i * 12 + k * 3)
      const u = flip ? 1 - cu : cu
      uvs.set([u0 + inset + u * (0.5 - 2 * inset), v0 + inset + cv * (0.5 - 2 * inset)], i * 8 + k * 2)
    })
    // counter-clockwise seen from above in a right-handed, Y-up scene
    const b = i * 4
    indices.set([b, b + 2, b + 1, b, b + 3, b + 2], i * 6)
  })
  return { positions, normals, uvs, indices }
}

/** A seeded value noise in 0..1 over a w × h grid (cells of `cell` px; wraps). */
function valueNoise(w: number, h: number, cell: number, seed: number): Float32Array {
  let a = seed >>> 0
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gw = Math.ceil(w / cell)
  const gh = Math.ceil(h / cell)
  const g = new Float32Array(gw * gh).map(() => rnd())
  const out = new Float32Array(w * h)
  const sm = (t: number) => t * t * (3 - 2 * t)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = x / cell
    const fy = y / cell
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const tx = sm(fx - ix)
    const ty = sm(fy - iy)
    const at = (i: number, j: number) => g[((j % gh) + gh) % gh * gw + (((i % gw) + gw) % gw)]!
    const top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx
    const bot = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx
    out[y * w + x] = top * (1 - ty) + bot * ty
  }
  return out
}

/** Multiply colours of the cells at full strength (linear-ish; white = unchanged). */
const CELL_TINT: Record<TownDecalKind, [number, number, number]> = {
  dirt: [0.66, 0.58, 0.48],
  moss: [0.6, 0.72, 0.48],
  puddle: [0.5, 0.56, 0.64],
}

/**
 * The decal atlas (RGBA8, DECAL_ATLAS_SIZE²): per cell a ragged blotch whose colour multiplies the ground (white at the
 * edges). `puddle` scales the puddle cell's strength (0: white, invisible under the multiply; 1: full).
 */
export function decalAtlas(puddle = 1, size = DECAL_ATLAS_SIZE): Uint8Array {
  const out = new Uint8Array(size * size * 4).fill(255)
  const half = size / 2
  const paint = (kind: TownDecalKind, cx: number, cy: number, seed: number, strength: number) => {
    const nA = valueNoise(half, half, half / 6, seed)
    const nB = valueNoise(half, half, half / 22, seed + 7)
    const tint = CELL_TINT[kind]
    for (let y = 0; y < half; y++) for (let x = 0; x < half; x++) {
      const dx = (x + 0.5) / half * 2 - 1
      const dy = (y + 0.5) / half * 2 - 1
      const r = Math.hypot(dx, dy)
      const k = y * half + x
      // a blotch: the radius pushed by the coarse noise, speckled by the fine one; puddles keep a smoother rim
      const edge = kind === 'puddle' ? 0.78 + 0.12 * (nA[k]! - 0.5) : 0.62 + 0.42 * (nA[k]! - 0.5)
      let m = Math.min(1, Math.max(0, (edge - r) / (kind === 'puddle' ? 0.12 : 0.3)))
      if (kind !== 'puddle') m *= 0.55 + 0.45 * nB[k]!
      m *= strength
      const o = ((cy + y) * size + cx + x) * 4
      for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.round(255 * (1 - m * (1 - tint[ch]!)))
      out[o + 3] = 255
    }
  }
  paint('dirt', 0, 0, 11, 1)
  paint('moss', half, 0, 23, 1)
  paint('puddle', 0, half, 37, Math.min(1, Math.max(0, puddle)))
  return out
}

function multiplyMaterial(scene: Scene, name: string, tex: Texture): StandardMaterial {
  const m = new StandardMaterial(name, scene)
  m.diffuseTexture = tex
  // unlit: with lighting off Babylon's diffuse term is 0, so the emissive white carries the texture (out = tex)
  m.disableLighting = true
  m.emissiveColor = Color3.White()
  m.diffuseColor = Color3.Black()
  m.specularColor.set(0, 0, 0)
  m.backFaceCulling = false
  m.fogEnabled = false
  m.disableDepthWrite = true
  m.zOffset = -2
  m.alphaMode = Constants.ALPHA_MULTIPLY
  // the multiply needs the transparent pass (after the ground it darkens); alpha itself is unused by the blend
  m.needAlphaBlending = () => true
  return m
}

function decalMesh(scene: Scene, name: string, rows: readonly TownDecalRow[], material: StandardMaterial): Mesh {
  const q = decalQuads(rows)
  const vd = new VertexData()
  vd.positions = q.positions
  vd.normals = q.normals
  vd.uvs = q.uvs
  vd.indices = q.indices
  const mesh = new Mesh(name, scene)
  vd.applyToMesh(mesh, false)
  mesh.material = material
  mesh.metadata = { sroWorld: TOWN_TAG }
  mesh.isPickable = false
  mesh.receiveShadows = false
  mesh.doNotSyncBoundingInfo = true
  mesh.freezeWorldMatrix()
  return mesh
}

/** The town's decals: one mesh for dirt and moss, one for the puddles (drawn only while the weather has puddles). */
export class TownDecals {
  readonly ground: Mesh | null
  readonly wet: Mesh | null
  private readonly atlas: RawTexture
  private readonly wetAtlas: RawTexture | null
  private readonly materials: StandardMaterial[] = []
  private puddle = -1

  constructor(readonly scene: Scene, rows: readonly TownDecalRow[]) {
    const dry = rows.filter(r => r.kind !== 'puddle')
    const wet = rows.filter(r => r.kind === 'puddle')
    const tex = (name: string, data: Uint8Array) => {
      const t = new RawTexture(data, DECAL_ATLAS_SIZE, DECAL_ATLAS_SIZE, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
      t.name = name
      t.wrapU = Texture.CLAMP_ADDRESSMODE
      t.wrapV = Texture.CLAMP_ADDRESSMODE
      return t
    }
    this.atlas = tex('townDecalAtlas', decalAtlas(1))
    this.wetAtlas = wet.length ? tex('townDecalWet', decalAtlas(0)) : null
    const groundMat = multiplyMaterial(scene, 'townDecals', this.atlas)
    this.materials.push(groundMat)
    this.ground = dry.length ? decalMesh(scene, 'townDecals', dry, groundMat) : null
    if (this.wetAtlas) {
      const wetMat = multiplyMaterial(scene, 'townDecalsWet', this.wetAtlas)
      this.materials.push(wetMat)
      this.wet = decalMesh(scene, 'townDecalsWet', wet, wetMat)
      this.wet.isVisible = false
    } else this.wet = null
  }

  /** The weather's puddle level (wxA.y, 0..1): the puddles fade in and out with it (a texture rewrite per PUDDLE_STEP). */
  setPuddles(level: number): void {
    if (!this.wet || !this.wetAtlas) return
    const k = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0))
    const on = k >= PUDDLE_MIN
    this.wet.isVisible = on
    if (!on || Math.abs(k - this.puddle) < PUDDLE_STEP) return
    this.puddle = k
    this.wetAtlas.update(decalAtlas(k))
  }

  meshes(): AbstractMesh[] {
    return [this.ground, this.wet].filter((m): m is Mesh => m !== null)
  }

  /** Decal quads drawn (puddles only while visible). */
  get count(): number {
    return (this.ground?.getTotalIndices() ?? 0) / 6 + (this.wet?.isVisible ? this.wet.getTotalIndices() / 6 : 0)
  }

  dispose(): void {
    this.ground?.dispose()
    this.wet?.dispose()
    for (const m of this.materials) m.dispose()
    this.atlas.dispose()
    this.wetAtlas?.dispose()
  }
}

/** The water seam TL-B fills (water.ts WaterRenderer). */
export interface TownPondTarget {
  setProfile(id: WaterProfileId, profile: WaterProfile | null): void
  setProfileLookup(fn: ((regionId: number) => WaterProfileId | null) | null): void
}

/** Gives the pond regions the water's 'town' profile (null: clears both, today's water). */
export function applyTownPond(water: TownPondTarget, pond: TownPondProfile | null | undefined): void {
  if (!pond || !pond.regions.length) {
    water.setProfileLookup(null)
    water.setProfile('town', null)
    return
  }
  const regions = new Set(pond.regions)
  water.setProfile('town', { color: [pond.color[0], pond.color[1], pond.color[2]], turbidity: pond.turbidity, ...(pond.reflection !== undefined ? { reflection: pond.reflection } : {}) })
  water.setProfileLookup(id => (regions.has(id) ? 'town' : null))
}

/** What the town part keeps of the dressing (the decals and the pond), from `attachTownDressing`. */
export interface TownDressingLayer {
  /** Per frame (cheap): follows the weather's puddles. */
  update(): void
  meshes(): AbstractMesh[]
  stats(): Readonly<Record<string, number>>
  /** Loaded and applied (the fetches are asynchronous). */
  readonly ready: Promise<void>
  dispose(): void
}

/**
 * Loads the world's dressing (manifest.town.dressing, and `town-decals.json` when the file has decals), applies the
 * pond profile and builds the decals. A world without the dressing gets an empty layer. Called by the town part (PBR
 * path only).
 */
export function attachTownDressing(host: TownHost): TownDressingLayer {
  const world = host.world
  let decals: TownDecals | null = null
  let pondOn = false
  let disposed = false
  const ready = (async () => {
    const rel = world.manifest.town?.dressing
    if (!rel) return
    let file: TownDressingFile | null = null
    try {
      file = await world.assets.json<TownDressingFile>(rel)
    } catch (err) {
      console.warn('[world] town dressing not loaded:', err)
      return
    }
    if (disposed || !file || file.kind !== 'townDressing') return
    if (file.pond) {
      applyTownPond(world.water, file.pond)
      pondOn = true
    }
    if (!Array.isArray(file.decals) || !file.decals.length) return
    let rows: TownDecalRow[] = []
    try {
      rows = readTownDecals(await world.assets.json<unknown>(TOWN_DECALS_FILE))
    } catch (err) {
      console.warn('[world] town decals not loaded:', err)
    }
    if (disposed || !rows.length) return
    decals = new TownDecals(host.scene, rows)
  })()
  return {
    ready,
    update(): void {
      decals?.setPuddles(world.weather.u.wxA.y)
    },
    meshes(): AbstractMesh[] {
      return decals?.meshes() ?? []
    },
    stats(): Readonly<Record<string, number>> {
      return { decals: decals?.count ?? 0, decalDraws: decals?.meshes().filter(m => m.isVisible).length ?? 0, pond: pondOn ? 1 : 0 }
    },
    dispose(): void {
      disposed = true
      decals?.dispose()
      decals = null
      if (pondOn) applyTownPond(world.water, null)
      pondOn = false
    },
  }
}
