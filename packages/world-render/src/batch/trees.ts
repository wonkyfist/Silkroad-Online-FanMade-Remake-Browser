/**
 * BT-T: the trees of the region batch (docs/BATCHING.md §3.3, §3.5; docs/WAVE_PLAN6.md §6.1 BT-T, D30, Q3).
 *
 * - **Static variants (§3.5).** On the PBR path with batching, a skinned tree or flower loads its static variant (BT-C:
 *   `models[i].staticVariant`, frame 0 of its default clip, skin removed) through `RegionBatcher.modelFor`: the skinned
 *   glb is not fetched, no animated clone is made, and the listeners still hear the original model. The skinned tall
 *   grass and reeds keep their retail clip (STATIC_VARIANT_KINDS). Low has no batcher, so it keeps the retail trees
 *   exactly (skinned trees hidden, the Low guard).
 * - **Tree groups (`mode: 'merge'`, the default with a material table).** Every foliage model (the static variants and
 *   the models that were static already) merges per region like the buildings, keyed (region, LOD group, leaf | wood,
 *   cut-out | opaque): in practice a region's trees are 2 draws (cut-out leaves, opaque wood). The merged vertices carry
 *   their tree's root (the placement origin, world space) as the `sroPivot` attribute (merge-core `pivotSize` 3), which
 *   BT-P's foliage plugin reads in place of the instance origin (`SRO_FOL_PIVOT`), so every tree bends around its own
 *   root. The group materials (`TreeMaterials`, one per key, shared by every region) are table materials (BT-P's
 *   `SRO_TABLE` through `BatchTables.bindMaterial`) carrying the foliage plugin: the static wind bend, the leaf flutter
 *   and translucency, and the **minimum breeze** (`SRO_FOL_BREEZE`, TREE_BREEZE): strength = max(wind, breeze), so the
 *   trees sway gently in calm air as the retail clips did, and more in wind (D30).
 * - **The per-model instancing fallback (`mode: 'instance'`, the scope-cut path).** `TreeInstances`: one world-wide
 *   thin-instance mesh per (model, primitive) with the converted material, holding every resident region's placements;
 *   the instances in range are written on the CPU when the camera moved 8 m (or a region came or went). The wind
 *   bends each instance around its own origin, the converted static-foliage materials get the minimum breeze while the
 *   set holds them (restored on release), and a set at count 0 is hidden, never drawn at the origin (TREES F13f). Its
 *   meshes cast through a WorldShadows caster source.
 * - **`mode: 'off'`:** foliage is refused (today's chunks and skinned clones): the material mode (no table) and tests.
 *
 * **Wave 12, the swap (T12-M; docs/TREES.md §W3.2–§W3.4, WF8–WF12; docs/WAVE_PLAN8.md §6.2):** with a swap source
 * (`BatchHost.treeSwap`, World's on the PBR path with trees 'new') and the merge mode:
 * - `modelFor` loads a swapped retail model's **species** (the manifest model the converter appended: its `far.glb`,
 *   LOD1 + LOD2, or a plant's two tiers) in its place, before any static variant: the retail glb is never fetched, a
 *   skinned retail tree makes no clone, and the listeners still hear the retail model. A model with `treeSwap` is
 *   always a tree claim (`cj_ricestraw`, the Tarim weed: WF12).
 * - The region batch folds the swap into each placement matrix (`foldSwap`: v × fit + offset, then the placement), so
 *   the species stands in the retail envelope with its trunk on the retail trunk; the tree's root (its pivot) is the
 *   folded matrix's translation.
 * - Each merged vertex of a swapped tree carries the 4-float pivot (TREE_PIVOT4_SIZE: root xyz, `bandWord` = band slot
 *   × 4 + tier) and `sroTreeW` (merge-core.ts). The slot is T12-N's (`TreeSlotSource`, World.trees); a swapped tree
 *   without one draws its LOD1 at every distance (tier 0) and no LOD2, so nothing is ever drawn twice. A retail tree
 *   sharing a group with a swapped one gets tier 0 (never banded).
 * - The crown tint (`treeSwap.tint` k ≥ 1): the species' `far.json` `trees.tints[k − 1]` names a tinted sprite per
 *   material; `TreeTints` makes a batch record whose albedo is that image (a table slot of its own), loaded before the
 *   region's plan runs. A tint that fails to load draws the species' own sprite.
 * Without a swap source every path above is off: the batch is wave 10's byte for byte.
 */
import {
  Matrix,
  Mesh,
  PBRMaterial,
  Quaternion,
  Vector3,
  type AbstractMesh,
  type BaseTexture,
  type Material,
  type Scene,
} from '@babylonjs/core'
import type { WorldModel, WorldPlacement } from '../../../convert/src/world/manifest.ts'
import type { MaterialBatchRecord, ObjectMaterial, ObjectMaterials } from '../materials.ts'
import { GROUP_RANGE_M, WORLD_OBJECT_LAYER, type StaticPrep } from '../objects.ts'
import { isFoliageModel } from '../pbr/classes.ts'
import { FOLIAGE_MIN_BREEZE, TREE_PIVOT_FLOATS, foliagePluginOf, type PbrFoliage, type SroFoliagePlugin } from '../pbr/foliage-plugin.ts'
import { SroSurfacePlugin } from '../pbr/surface-plugin.ts'
import { placementScale } from '../placement-scale.ts'
import { useWindowedLightFalloff } from '../render/babylon-fixes.ts'
import type { ShadowCasterSource } from '../render/shadows.ts'
import { placementKey } from '../trees/types.ts'
import type { BatchTables } from './region-batch.ts'
import type { BatchHost, BatchModelSource, TreeSwap, TreeSwapSource } from './types.ts'

/**
 * The minimum breeze of the batched trees (BATCHING Q3, D30): the strength the foliage plugin bends with in calm air,
 * max(wind, TREE_BREEZE). Tuned against the retail clips (BT-T, work/tmp/bt-t/clip-sway.ts): the breeze at which the
 * shader's calm sway (2 × b × min(h, 12)² × 0.012 peak to peak) matches each of the 18 retail trees' crown is 0.06–0.65,
 * median 0.13 (quartiles 0.07–0.26; the tallest trees need more because the bend stops growing above 12 m). 0.15 keeps
 * the median: a crown 12 m up swings ±0.26 m in calm air, and a storm (strength 1) still bends it by up to 1.7 m.
 */
export const TREE_BREEZE = FOLIAGE_MIN_BREEZE
/** The fallback set re-tests its instances once the camera moved this far (m; BATCHING §3.5). */
export const TREE_INSTANCE_STEP_M = 8
/** Floats per vertex of the trees' pivot attribute (the root, world space). */
export const TREE_PIVOT_SIZE = 3
/**
 * T12-M (TREES §W3.3): floats per vertex of a group holding a swapped species: root xyz and the band word (`bandWord`),
 * the foliage plugin's SRO_FOL_PIVOT4 / SRO_FOL_BAND layout (TREE_PIVOT_FLOATS).
 */
export const TREE_PIVOT4_SIZE = TREE_PIVOT_FLOATS
/** T12-M: the band slots T12-N hands out (R8, 128 × 64 = 8,192; TREES §W3.3). */
export const TREE_BAND_SLOTS = 8192

/** How the batch takes foliage (see the file comment). */
export type TreeMode = 'merge' | 'instance' | 'off'

export interface TreeOptions {
  /** Default: 'merge' with a material table, 'off' without (the material mode). */
  mode?: TreeMode
  /** The minimum breeze (default TREE_BREEZE). */
  breeze?: number
}

/** The key of a tree group (and of its material): leaves (flutter, translucency) or wood; cut-out or opaque. */
export interface TreeKey {
  leaf: boolean
  cutout: boolean
}

/** A foliage model (pbr/classes.ts' model rule, or materials ObjectMaterials marked as foliage). */
export function isTreeModel(model: Pick<WorldModel, 'source'>, geometry: readonly { material: Material | null }[] = []): boolean {
  if (isFoliageModel(model.source)) return true
  return geometry.some(p => !!(p.material?.metadata as { sroFoliage?: boolean } | null)?.sroFoliage)
}

/** The foliage folder of a model source (pbr/classes.ts' FOLIAGE_MODEL): 'tree', 'grass', 'flower', 'reed' or null. */
export function foliageKindOf(source: string): string | null {
  const m = /[\\/]nature[\\/](?:common|china[\\/][^\\/]+)[\\/](tree\d*|grass|flower|reed)[\\/]/i.exec(source)
  return m ? m[1]!.toLowerCase().replace(/\d+$/, '') : null
}

/**
 * The foliage kinds whose skinned models load their static variant. Measured on the retail clips (BT-T,
 * work/tmp/bt-t/clip-sway.ts): the 18 trees' crowns sway 0.2–2.3 m peak to peak, which the shader's h² bend with the
 * minimum breeze reproduces (the breeze matching each tree's crown: median 0.13); the flowers sway 2–3 cm. The tall
 * grass and the reeds sway 0.3–1 m at 2–4 m, which an h² bend cannot give a plant that short: they keep their retail
 * clip (today's clones).
 */
export const STATIC_VARIANT_KINDS: readonly string[] = ['tree', 'flower']

/** A skinned foliage model's static variant (BT-C), when the manifest has a loadable one; else null. */
export function staticVariantOf(model: WorldModel, models: readonly WorldModel[]): WorldModel | null {
  const i = model.staticVariant
  if (model.kind !== 'skinned' || i === undefined || i === model.index) return null
  const kind = foliageKindOf(model.source)
  if (!kind || !STATIC_VARIANT_KINDS.includes(kind)) return null
  const v = models[i]
  return v && v.index === i && v.kind === 'static' && !!v.glb ? v : null
}

/** The tree key of a converted material: its class says leaf (foliage) or wood; its alpha mode cut-out or opaque. */
export function treeKeyOf(record: Pick<MaterialBatchRecord, 'cls' | 'alpha'>): TreeKey {
  return { leaf: record.cls === 'foliage', cutout: record.alpha === 'mask' }
}

/** A tree key's name (group keys, material names). */
export function treeKeyName(k: Readonly<TreeKey>): string {
  return `tree:${k.leaf ? 'leaf' : 'wood'}${k.cutout ? '+cutout' : ''}`
}

// ---- wave 12: the swap (T12-M) ------------------------------------------------------------------------------------

/**
 * T12-N's band-slot allocator as the merge reads it (World.trees, duck-typed: W12-SA's `TreesPart` has no slot method):
 * the slot (0 … TREE_BAND_SLOTS − 1) the near field handed a placement (`key` = placementKey(region, uid)) when its
 * region placed it (the `placed` event comes before the region's commit), or −1 / null when it has none.
 */
export interface TreeSlotSource {
  slotOf(key: number): number | null
}

/** The world's band-slot source (World.trees when it has `slotOf`), or null. */
export function treeSlotsOf(world: unknown): TreeSlotSource | null {
  const t = (world as { trees?: unknown } | null | undefined)?.trees
  return t && typeof (t as TreeSlotSource).slotOf === 'function' ? (t as TreeSlotSource) : null
}

/** A placement's band slot from `slots` (−1: none, or out of range). */
export function bandSlotOf(slots: TreeSlotSource | null, p: Pick<WorldPlacement, 'region' | 'uid'>): number {
  if (!slots) return -1
  const s = slots.slotOf(placementKey(p.region, p.uid))
  return typeof s === 'number' && Number.isInteger(s) && s >= 0 && s < TREE_BAND_SLOTS ? s : -1
}

/**
 * The pivot's 4th float of a merged vertex (TREES §W3.3): band slot × 4 + tier, read by SRO_FOL_BAND (the vertex shows
 * while its slot's band byte equals its tier). 0 = tier 0: not banded, drawn at every distance (a retail tree, or a
 * swapped tree without a slot, whose LOD1 then stands in for every tier).
 */
export function bandWord(slot: number, tier: number): number {
  return tier > 0 && tier < 4 && slot >= 0 ? slot * 4 + tier : 0
}

/** The band word's slot and tier (`bandWord`'s inverse; tier 0: not banded). */
export function bandOfWord(w: number): { slot: number; tier: number } {
  const n = Math.round(w)
  return { slot: Math.floor(n / 4), tier: n & 3 }
}

/**
 * Folds a swap into the placement matrix at `m[o]` (Babylon's layout, row vectors; TREES §W3.2, WF20): a species
 * vertex v goes to (v ⊙ fit + offset) × P, so rows 0–2 scale by the fit and row 3 gains offset × P. Its translation
 * (m[o + 12..14]) is then the species' root: the retail trunk base.
 */
export function foldSwap(m: Float32Array, o: number, fit: readonly number[], offset: readonly number[] | null | undefined): void {
  const ox = offset?.[0] ?? 0, oy = offset?.[1] ?? 0, oz = offset?.[2] ?? 0
  if (ox || oy || oz) {
    for (let c = 0; c < 4; c++) m[o + 12 + c] = m[o + 12 + c]! + ox * m[o + c]! + oy * m[o + 4 + c]! + oz * m[o + 8 + c]!
  }
  for (let r = 0; r < 3; r++) {
    const f = fit[r] ?? 1
    if (f !== 1) for (let c = 0; c < 4; c++) m[o + r * 4 + c] = m[o + r * 4 + c]! * f
  }
}

/**
 * The 4-float pivots of a swapped piece (TREE_PIVOT4_SIZE per instance): each folded matrix's translation (the root)
 * and the band word of its slot and the piece's tier.
 */
export function swapPivots(matrices: Float32Array, slots: Int32Array, tier: number): Float32Array {
  const n = Math.floor(matrices.length / 16)
  const out = new Float32Array(n * 4)
  for (let k = 0; k < n; k++) {
    out[k * 4] = matrices[k * 16 + 12]!
    out[k * 4 + 1] = matrices[k * 16 + 13]!
    out[k * 4 + 2] = matrices[k * 16 + 14]!
    out[k * 4 + 3] = bandWord(slots[k]!, tier)
  }
  return out
}

/** Wave-10 pivots (TREE_PIVOT_SIZE per instance) widened to TREE_PIVOT4_SIZE with tier 0 (never banded). */
export function widenPivots(pivots: Float32Array): Float32Array {
  const n = Math.floor(pivots.length / 3)
  const out = new Float32Array(n * 4)
  for (let k = 0; k < n; k++) {
    out[k * 4] = pivots[k * 3]!
    out[k * 4 + 1] = pivots[k * 3 + 1]!
    out[k * 4 + 2] = pivots[k * 3 + 2]!
  }
  return out
}

/** far.json `trees.tints` (the tree tool's build.ts): per tint, per material name, its texture key and image file. */
interface FarTints {
  trees?: { tints?: Array<{ name?: string; materials?: Record<string, { texture?: string; image?: string }> }> }
}

/** What TreeTints reads files with (the world's Assets). */
export interface TintAssets {
  json<T>(rel: string): Promise<T>
  bytesOf(rel: string): Promise<Uint8Array>
}

interface TintImage {
  /** The tinted sprite's texture key (`tre_w12_<species>_leaf_<tint>.ddj`). */
  key: string
  /** Its encoded PNG. */
  bytes: Uint8Array
}

/**
 * A texture stand-in that only carries an encoded image (batch/atlas.ts `encodedView` reads `_buffer`): the table
 * decodes it into the tint's albedo cell. Never drawn and never on the GPU itself.
 */
function encodedTexture(name: string, bytes: Uint8Array): BaseTexture {
  const internal = { _buffer: bytes }
  return { name, getSize: () => ({ width: 0, height: 0 }), getInternalTexture: () => internal } as unknown as BaseTexture
}

/**
 * The crown tints of the swapped species (TREES §W3.4; far.json `trees.tints`): per species, the tinted sprite of each
 * material per tint, loaded once per world; per (record, tint) one batch record whose material reads as the species'
 * own (its surface plugin, cut-off, class) with the tinted sprite as its albedo, so the table gives it a slot of its own
 * and the merged tiers of a tinted retail model point at it. Records are made once and kept per base record (the
 * table counts its references on the record), so every region shares the tint's slot.
 */
export class TreeTints {
  private readonly loads = new Map<number, Promise<void>>()
  private readonly images = new Map<number, Array<Map<string, TintImage>>>()
  private readonly made = new WeakMap<MaterialBatchRecord, Map<number, MaterialBatchRecord>>()
  /** Tint images that failed to load (their trees draw the species' own sprite). */
  failed = 0
  private disposed = false

  constructor(private readonly assets: TintAssets | null) {}

  /** Tinted sprites loaded (one per tint and material). */
  get loaded(): number {
    let n = 0
    for (const list of this.images.values()) for (const m of list) n += m.size
    return n
  }

  /**
   * Starts loading a species' tints (its sidecar's `trees.tints`, then every image); resolves when done, never rejects.
   * The same promise for every caller.
   */
  load(species: WorldModel): Promise<void> {
    let p = this.loads.get(species.index)
    if (p) return p
    p = this.fetch(species).catch(err => {
      this.failed++
      console.warn('[batch] tree tints failed', species.source, err)
    })
    this.loads.set(species.index, p)
    return p
  }

  private async fetch(species: WorldModel): Promise<void> {
    const side = species.sidecar
    if (!this.assets || !side) return
    const far = await this.assets.json<FarTints>(side)
    const dir = side.replace(/\\/g, '/').replace(/[^/]*$/, '')
    const list: Array<Map<string, TintImage>> = []
    for (const t of far.trees?.tints ?? []) {
      const byName = new Map<string, TintImage>()
      list.push(byName)
      for (const [name, m] of Object.entries(t.materials ?? {})) {
        if (!m?.image || !m.texture) continue
        try {
          byName.set(name, { key: m.texture, bytes: await this.assets.bytesOf(`${dir}${m.image}`) })
        } catch (err) {
          this.failed++
          console.warn('[batch] tree tint image failed', m.image, err)
        }
      }
    }
    if (!this.disposed) this.images.set(species.index, list)
  }

  /** The loads still pending for `species` (null: none to wait for). */
  pending(species: WorldModel): Promise<void> | null {
    return this.images.has(species.index) ? null : this.load(species)
  }

  /**
   * The record a tinted tree's piece takes for `record` (a material of `species`): tint 0, an unknown tint or a material
   * the tint leaves alone (the bark) give `record` itself.
   */
  recordFor(species: WorldModel, record: MaterialBatchRecord, tint: number): MaterialBatchRecord {
    if (tint <= 0 || this.disposed) return record
    const img = this.images.get(species.index)?.[tint - 1]?.get(record.name)
    if (!img) return record
    let byTint = this.made.get(record)
    if (!byTint) this.made.set(record, (byTint = new Map()))
    let r = byTint.get(tint)
    if (!r) {
      // The species' converted material seen through a view whose albedo is the tinted sprite: the table reads its
      // surface plugin, cut-off and roughness from the original (never modified, BATCHING §4.5).
      const view = Object.create(record.material, {
        albedoTexture: { value: encodedTexture(`sroTint:${img.key}`, img.bytes), enumerable: true },
      }) as ObjectMaterial
      r = { ...record, material: view, texture: img.key, tintOf: record }
      byTint.set(tint, r)
    }
    return r
  }

  dispose(): void {
    this.disposed = true
    this.images.clear()
    this.loads.clear()
  }
}

/** The pivots of a list of placements: each one's root (its position), TREE_PIVOT_SIZE floats each. */
export function treePivots(placements: readonly WorldPlacement[]): Float32Array {
  const out = new Float32Array(placements.length * TREE_PIVOT_SIZE)
  placements.forEach((p, i) => {
    out[i * 3] = p.position[0]
    out[i * 3 + 1] = p.position[1]
    out[i * 3 + 2] = p.position[2]
  })
  return out
}

// ---- tree group materials ---------------------------------------------------------------------------------------

/**
 * The tree groups' materials, one per TreeKey, shared by every region: a table material (BT-P's SRO_TABLE, like
 * region-batch.ts' GroupMaterials) with the foliage plugin (pivot, wind, flutter, translucency, the minimum breeze).
 */
export class TreeMaterials {
  private readonly made = new Map<string, PBRMaterial>()
  private breezeValue: number

  constructor(
    readonly scene: Scene,
    readonly materials: ObjectMaterials,
    readonly tables: BatchTables,
    readonly foliage: PbrFoliage | null,
    breeze = TREE_BREEZE,
  ) {
    this.breezeValue = Math.max(0, breeze)
  }

  get count(): number {
    return this.made.size
  }

  /** The minimum breeze of every tree material (the lab's tuning knob). */
  get breeze(): number {
    return this.breezeValue
  }

  set breeze(v: number) {
    this.breezeValue = Math.max(0, Number.isFinite(v) ? v : 0)
    for (const m of this.made.values()) {
      const p = foliagePluginOf(m)
      if (p) p.breeze = this.breezeValue
    }
  }

  /** The material of a key (made on first use). */
  get(k: Readonly<TreeKey>): PBRMaterial {
    const name = treeKeyName(k)
    let mat = this.made.get(name)
    if (mat) return mat
    mat = useWindowedLightFalloff(new PBRMaterial(`batch:${name}`, this.scene))
    // Two-sided leaves are emitted twice (merge-core.ts): the group draws single-sided.
    mat.backFaceCulling = true
    mat.twoSidedLighting = false
    mat.metallic = 0
    mat.roughness = 1
    if (k.cutout) {
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      mat.alphaCutOff = 0.5
      mat.useAlphaFromAlbedoTexture = true
    } else {
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE
    }
    // Per slot from the table (sroSurf, direct intensity, cut-off); the plugin's own values only switch its defines.
    const plugin = new SroSurfacePlugin(mat, this.materials.pbr.shared, { cls: k.leaf ? 'foliage' : 'wood', baked: true })
    plugin.surf.w = 1
    mat.metadata = { sroBatchGroup: name, sroTree: true }
    this.tables.bindMaterial(mat, { cutout: k.cutout, sheen: false, lamp: false })
    // After the surface plugin (the foliage plugin needs it): the static wind around each tree's pivot. W12-SA: a tree
    // group (`tree`: the SRO_FOL_VDATA / SRO_FOL_BAND slots and the vec4 pivot; off on a wave-10 mesh, HEAD's code).
    this.foliage?.attach(mat, { leaf: k.leaf, kind: 'static', breeze: this.breezeValue, shadowWrapper: false, tree: true })
    this.made.set(name, mat)
    return mat
  }

  dispose(): void {
    for (const m of this.made.values()) m.dispose(false, false)
    this.made.clear()
  }
}

// ---- the per-model instancing fallback ----------------------------------------------------------------------------

interface TreeInstance {
  owner: number
  /** The instance's world matrix (mesh-in-model × placement), 16 floats. */
  m: Float32Array
  x: number
  y: number
  z: number
  r: number
  /** The LOD group's range (m, before the live scale). */
  range: number
}

interface TreeSet {
  mesh: Mesh
  inst: TreeInstance[]
  buf: Float32Array
  count: number
}

type Point = { readonly x: number; readonly y: number; readonly z: number }

/** The CSM caster seam (render/shadows.ts WorldShadows.addCasterSource), duck-typed: the render part may be absent. */
interface CasterHost {
  addCasterSource(source: ShadowCasterSource): () => void
}

/**
 * The scope-cut fallback (BATCHING §3.5): one world-wide thin-instance mesh per (model, primitive), range-culled per
 * instance on the CPU. Never drawn at count 0.
 */
export class TreeInstances implements ShadowCasterSource {
  private readonly sets = new Map<string, TreeSet>()
  /** Converted foliage plugins given the minimum breeze, with the breeze they had (restored on release). */
  private readonly touched = new Map<SroFoliagePlugin, number>()
  private readonly last = new Vector3(NaN, NaN, NaN)
  private dirty = true
  private scale = 1
  private visible = true
  /** False: no draw ranges (the viewer's LOD toggle, WorldObjects.setLod). */
  private ranges = true
  version = 0
  private readonly tmp = new Matrix()

  constructor(readonly scene: Scene, readonly breeze = TREE_BREEZE) {}

  get setCount(): number {
    return this.sets.size
  }

  /** Instances held (every resident placement). */
  get instances(): number {
    let n = 0
    for (const s of this.sets.values()) n += s.inst.length
    return n
  }

  /** Instances drawn after the last update. */
  get drawn(): number {
    let n = 0
    for (const s of this.sets.values()) n += s.count
    return n
  }

  /** A region's placements of a model (its static variant's geometry for a skinned tree). */
  add(owner: number, model: WorldModel, prep: StaticPrep, placements: readonly WorldPlacement[]): void {
    const bmin = Vector3.FromArray(model.boundsMin)
    const bmax = Vector3.FromArray(model.boundsMax)
    const r = Math.min(bmax.subtract(bmin).length() / 2, 40)
    const cy = (bmin.y + bmax.y) / 2
    prep.geometry.forEach((src, gi) => {
      if (src.getTotalVertices() <= 0) return
      const key = `${model.index}:${gi}`
      let set = this.sets.get(key)
      if (!set) {
        set = { mesh: this.setMesh(src, key), inst: [], buf: new Float32Array(16), count: 0 }
        this.sets.set(key, set)
      }
      const local = prep.locals[gi]!
      for (const p of placements) {
        // W12-SA (S-SCALE): the placement's uniform scale (absent: 1, today's matrix).
        const s = placementScale(p)
        Matrix.ComposeToRef(s === 1 ? Vector3.OneReadOnly : new Vector3(s, s, s), Quaternion.FromArray(p.rotation), Vector3.FromArray(p.position), this.tmp)
        const m = new Float32Array(16)
        local.multiplyToArray(this.tmp, m, 0)
        const range = GROUP_RANGE_M[p.group] ?? GROUP_RANGE_M[2]!
        set.inst.push({ owner, m, x: p.position[0], y: p.position[1] + cy * s, z: p.position[2], r: r * s, range })
      }
      const mat = src.material
      const fol = mat ? foliagePluginOf(mat) : null
      if (fol && !this.touched.has(fol)) {
        this.touched.set(fol, fol.breeze)
        fol.breeze = Math.max(fol.breeze, this.breeze)
      }
    })
    this.dirty = true
  }

  private setMesh(src: Mesh, key: string): Mesh {
    const mesh = src.clone(`batchTrees:${key}`, null, true)
    mesh.makeGeometryUnique()
    mesh.parent = null
    mesh.position.setAll(0)
    mesh.rotationQuaternion = Quaternion.Identity()
    mesh.scaling.setAll(1)
    mesh.sideOrientation = src.sideOrientation
    mesh.isPickable = false
    mesh.receiveShadows = true
    mesh.metadata = { sroWorld: 'object', sroBatch: 'trees', sroTree: true }
    mesh.layerMask |= WORLD_OBJECT_LAYER
    mesh.thinInstanceSetBuffer('matrix', new Float32Array(16), 16, false)
    mesh.thinInstanceCount = 0
    mesh.isVisible = false
    mesh.freezeWorldMatrix()
    mesh.setEnabled(true)
    return mesh
  }

  /** A region went: its instances leave every set (an emptied set's mesh goes). */
  remove(owner: number): void {
    for (const [key, set] of this.sets) {
      const before = set.inst.length
      set.inst = set.inst.filter(i => i.owner !== owner)
      if (set.inst.length === before) continue
      this.dirty = true
      if (!set.inst.length) {
        if (set.count > 0) this.version++
        set.mesh.dispose(false, false)
        this.sets.delete(key)
      }
    }
  }

  setRangeScale(scale: number): void {
    if (scale === this.scale) return
    this.scale = scale
    this.dirty = true
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return
    this.visible = on
    this.dirty = true
  }

  setRanges(on: boolean): void {
    if (on === this.ranges) return
    this.ranges = on
    this.dirty = true
  }

  /** Writes the instances in range when the camera moved TREE_INSTANCE_STEP_M (or anything changed). */
  update(cam: Point, force = false): void {
    const dx = cam.x - this.last.x, dy = cam.y - this.last.y, dz = cam.z - this.last.z
    const moved = !(dx * dx + dy * dy + dz * dz < TREE_INSTANCE_STEP_M * TREE_INSTANCE_STEP_M)
    if (!force && !this.dirty && !moved) return
    this.dirty = false
    this.last.set(cam.x, cam.y, cam.z)
    for (const set of this.sets.values()) {
      if (set.buf.length < set.inst.length * 16) {
        set.buf = new Float32Array(set.inst.length * 16)
        set.mesh.thinInstanceSetBuffer('matrix', set.buf, 16, false)
      }
      let n = 0
      if (this.visible) {
        for (const i of set.inst) {
          const d = Math.hypot(i.x - cam.x, i.y - cam.y, i.z - cam.z) - i.r
          if (!this.ranges || d < i.range * this.scale) set.buf.set(i.m, 16 * n++)
        }
      }
      const was = set.count
      set.count = n
      set.mesh.thinInstanceCount = n
      // Count 0: hidden (TREES F13f: a thin-instance mesh at count 0 must never draw its base at the origin).
      set.mesh.isVisible = n > 0
      if (n) {
        set.mesh.thinInstanceBufferUpdated('matrix')
        set.mesh.thinInstanceRefreshBoundingInfo(false)
      }
      // The caster list changes only when a set starts or stops drawing.
      if ((was > 0) !== (n > 0)) this.version++
    }
  }

  meshes(): AbstractMesh[] {
    return [...this.sets.values()].map(s => s.mesh)
  }

  /** ShadowCasterSource: the sets with instances drawn (the CSM culls them by its cascades). */
  casters(): Iterable<AbstractMesh> {
    const out: AbstractMesh[] = []
    for (const s of this.sets.values()) if (s.count > 0) out.push(s.mesh)
    return out
  }

  /** Drops every set and gives the converted materials their breeze back. */
  release(): void {
    for (const set of this.sets.values()) set.mesh.dispose(false, false)
    this.sets.clear()
    for (const [p, b] of this.touched) p.breeze = b
    this.touched.clear()
    this.dirty = true
    this.version++
  }
}

// ---- the part the region batch uses -------------------------------------------------------------------------------

/** How a foliage claim was taken: merged into the region's tree groups, or into the instancing fallback. */
export type TreeClaim = 'merge' | 'instance'

/** BT-T inside RegionBatchPart: the static variants, the tree groups' materials and the instancing fallback. */
export class TreeBatch {
  readonly mode: TreeMode
  readonly materials: TreeMaterials | null
  readonly instances: TreeInstances | null
  /** T12-M: the swap (merge mode with a swap source only; null: wave 10). */
  readonly swaps: TreeSwapSource | null
  /** T12-M: the crown tints of the swapped species (with a swap only). */
  readonly tints: TreeTints | null
  private shadowHost: CasterHost | null = null
  private shadowOff: (() => void) | null = null
  private disposed = false
  private readonly counters = { treeClaims: 0, treeInstanced: 0, treeSwapped: 0, treeUnslotted: 0 }

  constructor(readonly host: BatchHost, tables: BatchTables | null, opts: TreeOptions = {}) {
    const mode = opts.mode ?? (tables ? 'merge' : 'off')
    // Merging needs the table (the tree groups are table materials); without one the trees stay today's.
    this.mode = mode === 'merge' && !tables ? 'off' : mode
    const breeze = opts.breeze ?? TREE_BREEZE
    const foliage = (host.world as { foliage?: PbrFoliage } | null | undefined)?.foliage ?? null
    this.materials = this.mode === 'merge' ? new TreeMaterials(host.scene, host.materials, tables!, foliage, breeze) : null
    this.instances = this.mode === 'instance' ? new TreeInstances(host.scene, breeze) : null
    // T12-M: the swap only merges (the instancing fallback would draw both far tiers of a species on top of each other).
    this.swaps = this.mode === 'merge' ? host.treeSwap ?? null : null
    this.tints = this.swaps ? new TreeTints((host.materials as { assets?: TintAssets } | null)?.assets ?? null) : null
  }

  get stats(): Readonly<Record<string, number>> {
    return {
      ...this.counters,
      treeMaterials: this.materials?.count ?? 0,
      treeSets: this.instances?.setCount ?? 0,
      treeInstances: this.instances?.instances ?? 0,
      treeInstancesDrawn: this.instances?.drawn ?? 0,
      treeTints: this.tints?.loaded ?? 0,
    }
  }

  /** T12-M: the swap of a retail model (null: drawn as itself; always null without a swap source or outside merge). */
  swapOf(model: WorldModel): TreeSwap | null {
    if (this.disposed || !this.swaps) return null
    return this.swaps.swapOf(model)
  }

  /**
   * The model a region loads for `model`: T12-M, a swapped model's species (its retail glb is never fetched); else a
   * skinned foliage model's static variant (none when the mode is 'off').
   */
  modelFor(model: WorldModel): WorldModel {
    if (this.mode === 'off' || this.disposed) return model
    const swap = this.swapOf(model)
    if (swap) return swap.species
    return staticVariantOf(model, this.host.models) ?? model
  }

  /** T12-M: the band slots (World.trees, T12-N), read when a region's plan runs; null without a trees part. */
  slots(): TreeSlotSource | null {
    return this.swaps ? treeSlotsOf(this.host.world) : null
  }

  /** T12-M: counts a plan's swapped instances that had no band slot (drawn as LOD1 at every distance). */
  noteUnslotted(n: number): void {
    this.counters.treeUnslotted += n
  }

  /** H-12 TD-1: per owner, the swapped placements merged unbanded (a material group: the table refused a record). */
  private readonly unbandedBy = new Map<number, number[]>()
  private readonly unbandedKeys = new Map<number, number>()

  /**
   * A region plan's swapped placements whose pieces went to a material group (the table refused a species record):
   * their merged LOD1 has no band, so the trees part keeps them out of band 0 (no LOD0 overlay on top). Replaces the
   * owner's earlier list.
   */
  noteUnbanded(owner: number, keys: readonly number[]): void {
    this.dropUnbanded(owner)
    if (!keys.length || this.disposed) return
    this.unbandedBy.set(owner, [...keys])
    for (const k of keys) this.unbandedKeys.set(k, (this.unbandedKeys.get(k) ?? 0) + 1)
  }

  private dropUnbanded(owner: number): void {
    const keys = this.unbandedBy.get(owner)
    if (!keys) return
    this.unbandedBy.delete(owner)
    for (const k of keys) {
      const n = (this.unbandedKeys.get(k) ?? 0) - 1
      if (n > 0) this.unbandedKeys.set(k, n)
      else this.unbandedKeys.delete(k)
    }
  }

  /** True when a placement key's merged copy is unbanded (TD-1): it must not take the LOD0 overlay. */
  unbanded(key: number): boolean {
    return this.unbandedKeys.size > 0 && this.unbandedKeys.has(key)
  }

  /** Placement keys merged unbanded now. */
  get unbandedCount(): number {
    return this.unbandedKeys.size
  }

  /** Takes a foliage model's placements: 'merge' (the caller adds a tree claim), 'instance' (taken here), null: refused. */
  claim(owner: number, source: BatchModelSource, placements: readonly WorldPlacement[]): TreeClaim | null {
    if (this.disposed || this.mode === 'off' || !placements.length) return null
    if (this.mode === 'merge') {
      this.counters.treeClaims++
      // T12-M: a swapped model's crown tint starts loading now (the region's plan waits for it).
      const swap = this.swapOf(source.model)
      if (swap && source.entry?.model.index === swap.species.index) {
        this.counters.treeSwapped++
        if (swap.tint > 0) this.tints?.load(swap.species)
      }
      return 'merge'
    }
    this.instances!.add(owner, source.model, source.prep, placements)
    this.counters.treeInstanced++
    return 'instance'
  }

  /** A tree group's material (merge mode). */
  material(k: Readonly<TreeKey>): PBRMaterial {
    return this.materials!.get(k)
  }

  removeRegion(owner: number): void {
    this.instances?.remove(owner)
    this.dropUnbanded(owner)
  }

  setRangeScale(scale: number): void {
    this.instances?.setRangeScale(scale)
  }

  setVisible(on: boolean): void {
    this.instances?.setVisible(on)
  }

  setRanges(on: boolean): void {
    this.instances?.setRanges(on)
  }

  update(cam: Point, force = false): void {
    const set = this.instances
    if (!set) return
    set.update(cam, force)
    this.syncShadows()
  }

  /** Registers the fallback set with the world's current shadows part (it changes with the preset). */
  private syncShadows(): void {
    const sh = (this.host.world as { render?: { shadows?: unknown } } | null | undefined)?.render?.shadows
    const host = sh && typeof (sh as CasterHost).addCasterSource === 'function' ? (sh as CasterHost) : null
    if (host === this.shadowHost) return
    this.shadowOff?.()
    this.shadowOff = host ? host.addCasterSource(this.instances!) : null
    this.shadowHost = host
  }

  meshes(): AbstractMesh[] {
    return this.instances?.meshes() ?? []
  }

  release(): void {
    this.instances?.release()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.release()
    this.shadowOff?.()
    this.shadowOff = null
    this.shadowHost = null
    this.materials?.dispose()
    this.tints?.dispose()
  }
}
