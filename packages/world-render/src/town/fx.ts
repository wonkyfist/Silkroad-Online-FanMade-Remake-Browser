/**
 * The town's motion layers (docs/TOWN_LIFE.md §5.2, §5.3; docs/WAVE_PLAN7.md §6.1 TL-M): the steam/puff layer, the
 * leaf layer and the water ripple points. TL-M owns this file; the town part (town/index.ts, TL-C) makes one `TownFx`
 * with the world and calls its `update` / `setEnabled` / `meshes` / `stats` / `dispose` from its own (the wiring is
 * five lines, see `createTownFx`). PBR path only, like `World.town` (Low draws none of it: the Low guard).
 *
 * **Where it plays** comes from the world's own placements (World.objects' region listener), by model name
 * (TOWN_FX_RULES, LEAF_TREES), so nothing is hand-placed and a re-convert moves it along with the models:
 *   - smoke from the smith's chimney (`cj_weap_chimn`), the lab's emitter; steam over the teahouse tables
 *     (`cj_table_chair`, `cj_table01`); a fine white spray where the dragon fountain's water falls (`cj_wf_dr_03–05`,
 *     the bottom of each fall);
 *   - leaves shed from maples (`tre_maple*`) and petals from the blossom trees (`tre_frie01`) within LEAF_RANGE_M of
 *     the focus: they fall with the wind, flutter, settle on the ground, lie a while and shrink away;
 *   - ripple points ("local rain", water.ts `setRipplePoints`, at most RIPPLE_POINTS_MAX): a steady ring where each
 *     fall of the fountain lands, and a rise now and then by each goldfish (`cj_goldfish*`, the east pond and the
 *     pools). The list keeps one length while the layer lives (the water's define flips only when the town comes and
 *     goes: no recompile while walking).
 *
 * **Draws:** one thin-instanced quad per layer (puffs: alpha-blended, lit, no depth write; leaves: alpha-tested,
 * lit, two-sided): ≤ 2 draws, 0 where nothing is in range (the mesh is disabled). Both are PBR materials with one
 * procedural texture (no asset to download) and the instance colour (rgb tint, a alpha); not emissive, so the night
 * darkens them like the town. Never shadow casters or receivers, never pickable, tagged 'town' (never batched).
 *
 * **Cost:** the puffs are a pure function of (time, slot): no state per puff, no allocation per frame; the emitter and
 * tree assignment is redone once a second (or when the focus moves 8 m). Caps per preset: FX_CAPS.
 */
import {
  Constants,
  Mesh,
  PBRMaterial,
  RawTexture,
  Texture,
  Vector3,
  VertexData,
  type AbstractMesh,
  type Camera,
  type Scene,
  type Vector4,
} from '@babylonjs/core'
import type { WorldModel, WorldPlacement } from '../../../convert/src/world/manifest.ts'
import type { RegionListener } from '../objects.ts'
import { RIPPLE_POINTS_MAX, type RipplePoint } from '../pbr/water-town-plugin.ts'
import { placementScale } from '../placement-scale.ts'
import { TOWN_TAG } from './types.ts'

// ---- data ---------------------------------------------------------------------------------------------------------------

export type PuffKind = 'smoke' | 'steam' | 'spray'
export type FxKind = PuffKind | 'fish'

/** Where a placed model makes an effect: `at` a model-space point, or its bounds' top / bottom centre. */
export interface FxRule {
  /** Matched against the model's resource base name (lower case, no extension, no `#variant`). */
  model: RegExp
  kind: FxKind
  at: 'top' | 'bottom' | readonly [number, number, number]
  /** A ripple point here too, of this radius (m). */
  ripple?: number
}

/** TL-M's emitters (TOWN_LIFE §5.2–§5.3). */
export const TOWN_FX_RULES: readonly FxRule[] = [
  // The smith's chimney: the stack's top, above the placement origin (the lab's emitter, at the chimney's rim).
  { model: /^cj_weap_chimn$/, kind: 'smoke', at: [0, 8.4, 0] },
  // Tea on the teahouse tables (the west street).
  { model: /^cj_table_chair$/, kind: 'steam', at: [0, 1.2, 0] },
  { model: /^cj_table01$/, kind: 'steam', at: [0, 1.15, 0] },
  // The dragon fountain: the three falls' feet (their bounds' bottom centre) spray and ring the basin. H11-W-1: the rings
  // reach 2.2 m, past the curtain's footprint (≈ 1.5 m half-extent), so most of each ring's life is on open water.
  { model: /^cj_wf_dr_0[345]$/, kind: 'spray', at: 'bottom', ripple: 2.2 },
  // The goldfish rise now and then.
  { model: /^cj_goldfish\d*$/, kind: 'fish', at: [0, 0, 0] },
]

export type LeafKind = 'maple' | 'blossom'

/** Trees that shed (TOWN_LIFE §5.3): maples their leaves, the blossom trees their petals. */
export const LEAF_TREES: ReadonlyArray<{ model: RegExp; kind: LeafKind }> = [
  { model: /^tre_maple/, kind: 'maple' },
  { model: /^tre_frie01$/, kind: 'blossom' },
]

/** Caps per preset (TOWN_LIFE §5.1, §5.3, §9.2): puffs (the lab's 120 on Medium), leaves (150 Medium, 250 High+). */
export const FX_CAPS: Readonly<Record<'low' | 'medium' | 'high' | 'ultra', { puffs: number; leaves: number }>> = {
  low: { puffs: 0, leaves: 0 },
  medium: { puffs: 120, leaves: 150 },
  high: { puffs: 160, leaves: 250 },
  ultra: { puffs: 200, leaves: 250 },
}

/** Emitters and ripple sources farther than this from the focus are idle (m). */
export const FX_RANGE_M = 90
/** Trees shed within this distance of the focus (m). */
export const LEAF_RANGE_M = 40
/** The minimum breeze the puffs and leaves drift with (the trees' FOLIAGE_MIN_BREEZE). */
export const FX_MIN_BREEZE = 0.15

/** Per puff kind: life (s), rise (m/s), drift (m/s at strength 0 and per unit strength), size (m, born → gone), peak alpha, grey, puffs per emitter. */
export const PUFF_KINDS: Readonly<Record<PuffKind, {
  life: number; rise: number; drift0: number; drift1: number; size0: number; size1: number; alpha: number; grey: number; per: number
}>> = {
  smoke: { life: 7, rise: 0.9, drift0: 0.35, drift1: 1.6, size0: 0.6, size1: 3.6, alpha: 0.75, grey: 0.66, per: 18 },
  steam: { life: 2.6, rise: 0.45, drift0: 0.12, drift1: 0.8, size0: 0.16, size1: 0.8, alpha: 0.45, grey: 0.97, per: 6 },
  spray: { life: 1.3, rise: 0.5, drift0: 0.2, drift1: 0.8, size0: 0.35, size1: 1.4, alpha: 0.5, grey: 1, per: 12 },
}

// ---- pure helpers (tests) -------------------------------------------------------------------------------------------

/**
 * A placed model's world point: `p` (model space) under the placement's scale (W12-SA S-SCALE: uniform, 1 when absent),
 * rotation (glTF quaternion) and position.
 */
export function placeAt(pl: Pick<WorldPlacement, 'position' | 'rotation' | 'scale'>, p: readonly [number, number, number]): [number, number, number] {
  const [qx, qy, qz, qw] = pl.rotation
  const k = placementScale(pl)
  const [x, y, z] = k === 1 ? p : [p[0] * k, p[1] * k, p[2] * k]
  // v' = v + 2w (q × v) + 2 q × (q × v)
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x)
  return [
    pl.position[0] + x + qw * tx + (qy * tz - qz * ty),
    pl.position[1] + y + qw * ty + (qz * tx - qx * tz),
    pl.position[2] + z + qw * tz + (qx * ty - qy * tx),
  ]
}

/** A model source's resource base name (lower case, no directories, `#variant` or extension). */
export function fxModelBase(source: string): string {
  return source.replace(/\\/g, '/').toLowerCase().replace(/^.*\//, '').replace(/#.*$/, '').replace(/\.(bsr|glb)$/, '')
}

/** The model-space point a rule names for a model. */
export function ruleLocal(rule: Pick<FxRule, 'at'>, model: Pick<WorldModel, 'boundsMin' | 'boundsMax'>): [number, number, number] {
  if (Array.isArray(rule.at)) return [rule.at[0]!, rule.at[1]!, rule.at[2]!]
  const lo = model.boundsMin, hi = model.boundsMax
  return [(lo[0] + hi[0]) / 2, rule.at === 'top' ? hi[1] : lo[1], (lo[2] + hi[2]) / 2]
}

/**
 * One puff's state at `nowS` (pure; no state per puff): slot `seed` in [0, 1) of an emitter at `e`, the wind
 * direction (x, z) and strength 0..1. Writes [x, y, z, size, alpha] into `out` (no allocation).
 */
export function puffAt(kind: PuffKind, e: readonly [number, number, number], seed: number, nowS: number, windX: number, windZ: number, strength: number, out: Float32Array | number[]): void {
  const k = PUFF_KINDS[kind]
  const ph = nowS / k.life + seed
  const age = ph - Math.floor(ph)
  const tS = age * k.life
  const drift = (k.drift0 + k.drift1 * strength) * tS
  const wob = Math.sin(seed * 40 + nowS * 0.4) * 0.3 * age
  out[0] = e[0] + windX * drift + windZ * wob
  out[1] = e[1] + k.rise * tS
  out[2] = e[2] + windZ * drift - windX * wob
  out[3] = k.size0 + (k.size1 - k.size0) * age
  out[4] = Math.min(1, age * 4) * (1 - age) * k.alpha
}

/** A deterministic hash of two numbers to [0, 1). */
export function hash01(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return s - Math.floor(s)
}

/** A leaf's phases: falling (`fallS`), lying (LEAF_REST_S), shrinking (LEAF_FADE_S). */
export const LEAF_FALL_MS = 0.75
export const LEAF_REST_S = 5
export const LEAF_FADE_S = 1.2

/**
 * One leaf at `nowS` (pure): slot `seed` of a tree whose crown spans `crown` (x, z, radius, low y, high y) over ground
 * `groundY`; the wind (x, z, strength). Writes [x, y, z, scale 0..1, spin angle, landed 0|1] into `out`.
 */
export function leafAt(
  crown: readonly [number, number, number, number, number],
  groundY: number,
  seed: number,
  nowS: number,
  windX: number,
  windZ: number,
  strength: number,
  out: Float32Array | number[],
): void {
  const [cx, cz, cr, lo, hi] = crown
  const top = Math.max(lo, hi)
  const fallH = Math.max(0.5, top - groundY)
  const fallS = fallH / LEAF_FALL_MS
  const period = fallS + LEAF_REST_S + LEAF_FADE_S
  const ph = nowS / period + seed
  const cycle = Math.floor(ph)
  const tS = (ph - cycle) * period
  const a = hash01(seed * 97, cycle) * Math.PI * 2
  const r = Math.sqrt(hash01(cycle, seed * 53)) * cr
  const y0 = lo + (top - lo) * hash01(seed * 13 + cycle, 7)
  const t = Math.min(tS, (y0 - groundY) / LEAF_FALL_MS)
  const drift = (0.25 + 1.4 * strength) * t
  const fl = Math.sin(t * 2.3 + seed * 30) * 0.45
  out[0] = cx + Math.cos(a) * r + windX * drift + windZ * fl
  out[2] = cz + Math.sin(a) * r + windZ * drift - windX * fl
  const landed = tS * LEAF_FALL_MS >= y0 - groundY
  out[1] = landed ? groundY + 0.02 : y0 - tS * LEAF_FALL_MS
  const fadeT = tS - fallS - LEAF_REST_S
  out[3] = fadeT > 0 ? Math.max(0, 1 - fadeT / LEAF_FADE_S) : 1
  out[4] = landed ? a : t * (2 + 2 * hash01(seed, 3))
  out[5] = landed ? 1 : 0
}

// ---- the layer --------------------------------------------------------------------------------------------------------

/** What the layers read from the world (World satisfies it; tests pass a fake). */
export interface TownFxWorld {
  readonly quality: 'low' | 'medium' | 'high' | 'ultra'
  readonly objects: { addRegionListener(l: RegionListener): () => void }
  readonly weather: { readonly u: { readonly wxB: Vector4 } }
  readonly water: { setRipplePoints(points: readonly RipplePoint[] | null): void }
}

export interface TownFxHost {
  readonly scene: Scene
  readonly world: TownFxWorld
}

interface Emitter {
  region: number
  kind: PuffKind
  p: [number, number, number]
}

interface Ripple {
  region: number
  fish: boolean
  x: number
  z: number
  radius: number
}

interface Tree {
  region: number
  kind: LeafKind
  crown: [number, number, number, number, number]
  ground: number
}

/** The procedural textures (no asset): a soft puff and a leaf with its midrib, grey (the instance colour tints). */
function fxTextures(scene: Scene): { puff: RawTexture; leaf: RawTexture } {
  const n = 64
  const puff = new Uint8Array(n * n * 4)
  const leaf = new Uint8Array(n * n * 4)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n * 2 - 1, v = (j + 0.5) / n * 2 - 1
    const o = (j * n + i) * 4
    const d = Math.hypot(u, v)
    const soft = Math.max(0, 1 - d)
    const lump = 0.85 + 0.15 * Math.sin(u * 7.1 + v * 3.3) * Math.sin(v * 6.3 - u * 2.1)
    puff[o] = puff[o + 1] = puff[o + 2] = 235
    puff[o + 3] = Math.round(255 * Math.min(1, soft * soft * (3 - 2 * soft) * lump))
    // An ovate leaf along v (pointed at both ends), a darker midrib.
    const half = 0.62 * Math.sin(Math.PI * Math.min(1, Math.max(0, (v + 1) / 2)))
    const inside = Math.abs(u) <= half
    const rib = Math.abs(u) < 0.06 ? 0.72 : 1
    const shade = Math.round(255 * rib * (0.82 + 0.18 * (1 - Math.abs(u) / Math.max(half, 1e-3))))
    leaf[o] = leaf[o + 1] = leaf[o + 2] = shade
    leaf[o + 3] = inside ? 255 : 0
  }
  const make = (data: Uint8Array, name: string) => {
    const t = new RawTexture(data, n, n, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
    t.name = name
    t.hasAlpha = true
    t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE
    return t
  }
  return { puff: make(puff, 'town_fx_puff'), leaf: make(leaf, 'town_fx_leaf') }
}

/** The fx materials (also the material-budgets registration): lit PBR, instance colour, one texture each. */
export function createFxMaterials(scene: Scene, tex = fxTextures(scene)): { puff: PBRMaterial; leaf: PBRMaterial; textures: RawTexture[] } {
  const puff = new PBRMaterial('town_fx_puffs', scene)
  puff.albedoTexture = tex.puff
  puff.useAlphaFromAlbedoTexture = true
  puff.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND
  puff.metallic = 0
  puff.roughness = 1
  puff.backFaceCulling = false
  puff.disableDepthWrite = true
  puff.environmentIntensity = 0.8
  const leaf = new PBRMaterial('town_fx_leaves', scene)
  leaf.albedoTexture = tex.leaf
  leaf.useAlphaFromAlbedoTexture = true
  leaf.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
  leaf.alphaCutOff = 0.5
  leaf.metallic = 0
  leaf.roughness = 0.8
  leaf.backFaceCulling = false
  leaf.twoSidedLighting = true
  return { puff, leaf, textures: [tex.puff, tex.leaf] }
}

/** A unit quad in the XY plane (puffs face the camera) or XZ (leaves lie flat before their spin); normals up. */
function quad(name: string, scene: Scene, flat: boolean): Mesh {
  const m = new Mesh(name, scene)
  const vd = new VertexData()
  vd.positions = flat ? [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5] : [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]
  // Both face up: a puff is lit like the sky lights a cloud (its normal is the camera's up), not dark against the sun.
  vd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]
  vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1]
  vd.indices = [0, 1, 2, 0, 2, 3]
  vd.applyToMesh(m)
  m.isPickable = false
  m.receiveShadows = false
  m.alwaysSelectAsActiveMesh = true
  m.doNotSyncBoundingInfo = true
  m.metadata = { sroWorld: TOWN_TAG }
  return m
}

const MAPLE_TINTS: ReadonlyArray<readonly [number, number, number]> = [[0.72, 0.17, 0.07], [0.86, 0.4, 0.1], [0.8, 0.6, 0.16], [0.55, 0.58, 0.2]]
const BLOSSOM_TINTS: ReadonlyArray<readonly [number, number, number]> = [[0.96, 0.66, 0.76], [0.98, 0.84, 0.88]]

/** The town's puffs, leaves and ripples (see the file comment). */
export class TownFx {
  readonly caps: { puffs: number; leaves: number }
  private enabled = true
  private disposed = false
  private nowS = 0
  private readonly emitters: Emitter[] = []
  private readonly ripples: Ripple[] = []
  private readonly trees: Tree[] = []
  private readonly offListener: () => void
  private readonly mats: { puff: PBRMaterial; leaf: PBRMaterial; textures: RawTexture[] }
  readonly puffMesh: Mesh
  readonly leafMesh: Mesh
  private readonly puffBuf: Float32Array
  private readonly puffCol: Float32Array
  private readonly leafBuf: Float32Array
  private readonly leafCol: Float32Array
  /** Per puff slot: its emitter index and seed (re-assigned once a second). */
  private readonly puffSlot: Int32Array
  private readonly puffSeed: Float32Array
  private puffCount = 0
  private readonly leafSlot: Int32Array
  private readonly leafSeed: Float32Array
  private leafCount = 0
  private assignAt = -Infinity
  private readonly lastFocus = { x: Infinity, z: Infinity }
  private dirty = true
  /** The ripple list handed to the water (one length while it lives; idle entries have strength 0). */
  private ripplePoints: RipplePoint[] = []
  private readonly tmp = new Float32Array(6)
  private readonly right = new Vector3()
  private readonly up = new Vector3()
  private readonly fwd = new Vector3()

  constructor(readonly host: TownFxHost, opts: { caps?: { puffs: number; leaves: number } } = {}) {
    const scene = host.scene
    this.caps = opts.caps ?? FX_CAPS[host.world.quality] ?? FX_CAPS.medium
    this.mats = createFxMaterials(scene)
    this.puffMesh = quad('town_fx_puffs', scene, false)
    this.puffMesh.material = this.mats.puff
    this.puffMesh.hasVertexAlpha = true
    this.leafMesh = quad('town_fx_leaves', scene, true)
    this.leafMesh.material = this.mats.leaf
    const np = Math.max(1, this.caps.puffs), nl = Math.max(1, this.caps.leaves)
    this.puffBuf = new Float32Array(np * 16)
    this.puffCol = new Float32Array(np * 4)
    this.leafBuf = new Float32Array(nl * 16)
    this.leafCol = new Float32Array(nl * 4).fill(1)
    this.puffSlot = new Int32Array(np)
    this.puffSeed = new Float32Array(np)
    this.leafSlot = new Int32Array(nl)
    this.leafSeed = new Float32Array(nl)
    this.puffMesh.thinInstanceSetBuffer('matrix', this.puffBuf, 16, false)
    this.puffMesh.thinInstanceSetBuffer('color', this.puffCol, 4, false)
    this.leafMesh.thinInstanceSetBuffer('matrix', this.leafBuf, 16, false)
    this.leafMesh.thinInstanceSetBuffer('color', this.leafCol, 4, false)
    this.puffMesh.thinInstanceCount = 0
    this.leafMesh.thinInstanceCount = 0
    this.puffMesh.setEnabled(false)
    this.leafMesh.setEnabled(false)
    this.offListener = host.world.objects.addRegionListener({
      placed: (region, model, _info, _meshes, placements) => this.placed(region, model, placements),
      removed: region => this.removed(region),
    })
  }

  // ---- sources ----

  private placed(region: number, model: WorldModel, placements: readonly WorldPlacement[]): void {
    if (this.disposed || !placements.length) return
    const base = fxModelBase(model.source)
    for (const rule of TOWN_FX_RULES) {
      if (!rule.model.test(base)) continue
      const local = ruleLocal(rule, model)
      for (const pl of placements) {
        const p = placeAt(pl, local)
        if (rule.kind === 'fish') this.ripples.push({ region, fish: true, x: p[0], z: p[2], radius: 0.9 })
        else {
          this.emitters.push({ region, kind: rule.kind, p })
          if (rule.ripple) this.ripples.push({ region, fish: false, x: p[0], z: p[2], radius: rule.ripple })
        }
      }
      this.dirty = true
    }
    const tree = LEAF_TREES.find(t => t.model.test(base))
    if (tree) {
      const lo = model.boundsMin, hi = model.boundsMax
      const h = hi[1] - lo[1]
      const r = Math.max(1, 0.45 * Math.min(hi[0] - lo[0], hi[2] - lo[2]))
      for (const pl of placements) {
        const c = placeAt(pl, [(lo[0] + hi[0]) / 2, 0, (lo[2] + hi[2]) / 2])
        const y = pl.position[1]
        // W12-SA (S-SCALE): the crown grows with the placement's scale (1 when absent: today's crown).
        const k = placementScale(pl)
        const lo1 = lo[1] * k, h1 = h * k
        this.trees.push({ region, kind: tree.kind, crown: [c[0], c[2], r * k, y + lo1 + 0.45 * h1, y + lo1 + 0.85 * h1], ground: y })
      }
      this.dirty = true
    }
  }

  private removed(region: number): void {
    const keep = <T extends { region: number }>(list: T[]) => {
      let w = 0
      for (const e of list) if (e.region !== region) list[w++] = e
      const changed = w !== list.length
      list.length = w
      return changed
    }
    const a = keep(this.emitters), b = keep(this.trees), c = keep(this.ripples)
    if (a || b || c) this.dirty = true
  }

  // ---- per frame ----

  setEnabled(on: boolean): void {
    if (this.enabled === on) return
    this.enabled = on
    if (!on) {
      this.puffMesh.setEnabled(false)
      this.leafMesh.setEnabled(false)
    }
    this.dirty = true
  }

  /** Per frame, after the life part (the town part's update). */
  update(camera: Camera | null, dt: number): void {
    if (this.disposed) return
    this.nowS += Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0))
    if (!this.enabled || !camera) return
    const target = (camera as Camera & { target?: Vector3 }).target
    const focus = target instanceof Vector3 ? target : camera.globalPosition
    const moved = Math.hypot(focus.x - this.lastFocus.x, focus.z - this.lastFocus.z) > 8
    if (this.dirty || moved || this.nowS - this.assignAt > 1) this.assign(focus.x, focus.z)
    const wx = this.host.world.weather.u.wxB
    let dx = wx.x, dz = wx.y
    const dl = Math.hypot(dx, dz)
    if (dl > 1e-4) { dx /= dl; dz /= dl } else { dx = 1; dz = 0 }
    const strength = Math.max(FX_MIN_BREEZE, Math.min(1, Math.max(0, wx.z)))
    this.drawPuffs(camera, dx, dz, strength)
    this.drawLeaves(dx, dz, strength)
    this.updateRipples()
  }

  /** Gives the puff slots to the nearest emitters and the leaf slots to the nearest trees (within range, to the caps). */
  private assign(fx: number, fz: number): void {
    this.assignAt = this.nowS
    this.lastFocus.x = fx
    this.lastFocus.z = fz
    const wasDirty = this.dirty
    this.dirty = false
    // Puffs: emitters by distance, each its kind's share, until the cap.
    const order = this.emitters.map((e, i) => ({ i, d: Math.hypot(e.p[0] - fx, e.p[2] - fz) })).filter(e => e.d <= FX_RANGE_M).sort((a, b) => a.d - b.d)
    let n = 0
    for (const { i } of order) {
      const per = PUFF_KINDS[this.emitters[i]!.kind].per
      for (let k = 0; k < per && n < this.caps.puffs; k++, n++) {
        this.puffSlot[n] = i
        this.puffSeed[n] = (k + hash01(i, 1) * 0.5) / per
      }
      if (n >= this.caps.puffs) break
    }
    this.puffCount = n
    // Leaves: trees within range, the slots dealt round-robin (nearest first).
    const trees = this.trees.map((t, i) => ({ i, d: Math.hypot(t.crown[0] - fx, t.crown[1] - fz) })).filter(t => t.d <= LEAF_RANGE_M).sort((a, b) => a.d - b.d)
    const perTree = trees.length ? Math.min(12, Math.ceil(this.caps.leaves / trees.length)) : 0
    let m = 0
    for (let k = 0; k < perTree && m < this.caps.leaves; k++) {
      for (const { i } of trees) {
        if (m >= this.caps.leaves) break
        this.leafSlot[m] = i
        this.leafSeed[m] = hash01(i * 7 + k, 5)
        const tint = (this.trees[i]!.kind === 'maple' ? MAPLE_TINTS : BLOSSOM_TINTS)
        const c = tint[Math.floor(hash01(i, k) * tint.length) % tint.length]!
        this.leafCol[m * 4] = c[0]
        this.leafCol[m * 4 + 1] = c[1]
        this.leafCol[m * 4 + 2] = c[2]
        this.leafCol[m * 4 + 3] = 1
        m++
      }
    }
    this.leafCount = m
    this.leafMesh.thinInstanceBufferUpdated('color')
    if (wasDirty) this.rebuildRipples()
  }

  private drawPuffs(camera: Camera, wx: number, wz: number, strength: number): void {
    const n = this.puffCount
    this.puffMesh.setEnabled(n > 0)
    if (!n) return
    const view = camera.getViewMatrix()
    // The camera's right and up in world space (the view matrix's rows).
    const m = view.m
    this.right.set(m[0]!, m[4]!, m[8]!)
    this.up.set(m[1]!, m[5]!, m[9]!)
    Vector3.CrossToRef(this.right, this.up, this.fwd)
    const r = this.right, u = this.up, f = this.fwd
    const out = this.tmp
    for (let i = 0; i < n; i++) {
      const e = this.emitters[this.puffSlot[i]!]
      if (!e) continue
      puffAt(e.kind, e.p, this.puffSeed[i]!, this.nowS, wx, wz, strength, out)
      const s = out[3]!
      const o = i * 16
      const b = this.puffBuf
      b[o] = r.x * s; b[o + 1] = r.y * s; b[o + 2] = r.z * s; b[o + 3] = 0
      b[o + 4] = u.x * s; b[o + 5] = u.y * s; b[o + 6] = u.z * s; b[o + 7] = 0
      b[o + 8] = f.x; b[o + 9] = f.y; b[o + 10] = f.z; b[o + 11] = 0
      b[o + 12] = out[0]!; b[o + 13] = out[1]!; b[o + 14] = out[2]!; b[o + 15] = 1
      const g = PUFF_KINDS[e.kind].grey
      const c = this.puffCol
      c[i * 4] = g; c[i * 4 + 1] = g; c[i * 4 + 2] = g; c[i * 4 + 3] = out[4]!
    }
    this.puffMesh.thinInstanceCount = n
    this.puffMesh.thinInstanceBufferUpdated('matrix')
    this.puffMesh.thinInstanceBufferUpdated('color')
  }

  private drawLeaves(wx: number, wz: number, strength: number): void {
    const n = this.leafCount
    this.leafMesh.setEnabled(n > 0)
    if (!n) return
    const out = this.tmp
    const b = this.leafBuf
    for (let i = 0; i < n; i++) {
      const t = this.trees[this.leafSlot[i]!]
      if (!t) continue
      leafAt(t.crown, t.ground, this.leafSeed[i]!, this.nowS, wx, wz, strength, out)
      const s = out[3]! * (t.kind === 'maple' ? 0.13 : 0.08)
      const ang = out[4]!
      const ca = Math.cos(ang), sa = Math.sin(ang)
      // Falling: tumbling about a tilted axis; landed: flat with its yaw.
      const tilt = out[5] ? 0 : 0.9 * Math.sin(ang * 1.3 + this.leafSeed[i]! * 9)
      const ct = Math.cos(tilt), st = Math.sin(tilt)
      const o = i * 16
      // R = Ry(ang) · Rx(tilt), scaled.
      b[o] = ca * s; b[o + 1] = 0; b[o + 2] = -sa * s; b[o + 3] = 0
      b[o + 4] = sa * st * s; b[o + 5] = ct * s; b[o + 6] = ca * st * s; b[o + 7] = 0
      b[o + 8] = sa * ct * s; b[o + 9] = -st * s; b[o + 10] = ca * ct * s; b[o + 11] = 0
      b[o + 12] = out[0]!; b[o + 13] = out[1]!; b[o + 14] = out[2]!; b[o + 15] = 1
    }
    this.leafMesh.thinInstanceCount = n
    this.leafMesh.thinInstanceBufferUpdated('matrix')
  }

  /**
   * The list for the water: RIPPLE_POINTS_MAX entries from the first source on, never shrunk while the layer lives
   * (the water's SRO_WATER_POINTS flips only with none ↔ some: one compile when the town's water first streams in,
   * none while walking; idle entries have strength 0). Null again on dispose.
   */
  private rebuildRipples(): void {
    if (this.ripplePoints.length || !this.ripples.length) return
    this.ripplePoints = Array.from({ length: RIPPLE_POINTS_MAX }, () => ({ x: 0, z: 0, radiusM: 0, strength: 0 }))
  }

  private updateRipples(): void {
    const pts = this.ripplePoints
    if (!pts.length) return
    const fx = this.lastFocus.x, fz = this.lastFocus.z
    // The fountain's falls first, then the fish nearest the focus.
    let k = 0
    for (const pass of [false, true]) {
      for (const r of this.ripples) {
        if (k >= pts.length) break
        if (r.fish !== pass) continue
        const d = Math.hypot(r.x - fx, r.z - fz)
        if (d > FX_RANGE_M) continue
        const p = pts[k++]!
        if (!r.fish) {
          p.x = r.x; p.z = r.z; p.radiusM = r.radius; p.strength = 0.7
          continue
        }
        // A fish rises once every 5–9 s for 1.8 s, a little off its spot.
        const period = 5 + 4 * hash01(r.x, r.z)
        const ph = this.nowS / period + hash01(r.z, r.x)
        const cycle = Math.floor(ph)
        const on = (ph - cycle) * period < 1.8
        p.x = r.x + (hash01(cycle, r.x) - 0.5) * 1.6
        p.z = r.z + (hash01(r.z, cycle) - 0.5) * 1.6
        p.radiusM = r.radius
        p.strength = on ? 0.55 : 0
      }
    }
    for (; k < pts.length; k++) pts[k]!.strength = 0
    this.host.world.water.setRipplePoints(pts)
  }

  meshes(): AbstractMesh[] {
    return [this.puffMesh, this.leafMesh]
  }

  stats(): Readonly<Record<string, number>> {
    return {
      fxEmitters: this.emitters.length,
      fxPuffs: this.enabled ? this.puffCount : 0,
      fxTrees: this.trees.length,
      fxLeaves: this.enabled ? this.leafCount : 0,
      fxRipples: this.ripplePoints.length,
      fxDraws: this.enabled ? (this.puffCount > 0 ? 1 : 0) + (this.leafCount > 0 ? 1 : 0) : 0,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offListener()
    if (this.ripplePoints.length) {
      try {
        this.host.world.water.setRipplePoints(null)
      } catch (err) {
        console.warn('[town] ripple points not cleared:', err)
      }
    }
    this.ripplePoints = []
    this.puffMesh.dispose()
    this.leafMesh.dispose()
    this.mats.puff.dispose()
    this.mats.leaf.dispose()
    for (const t of this.mats.textures) t.dispose()
  }
}

/**
 * The town's motion layers for a world on the PBR path (null on Low: the Low guard). TL-C's town part owns the
 * wiring: `fx = createTownFx(host)` in its constructor, `fx?.update(camera, dt)` in its update, `fx?.setEnabled(on)`
 * with its own, `...fx.meshes()` in `meshes()`, its `stats()` merged, `fx?.dispose()` in `dispose()`.
 */
export function createTownFx(host: TownFxHost, opts: { caps?: { puffs: number; leaves: number } } = {}): TownFx | null {
  if (host.world.quality === 'low') return null
  return new TownFx(host, opts)
}
