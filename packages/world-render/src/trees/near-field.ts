/**
 * The near field: the LOD0 overlay of the new trees (docs/TREES.md Part W §W3.1, §W3.3, §W3.4, §W3.8; docs/WAVE_PLAN8.md
 * §6.2 T12-N, D25). Owner: T12-N.
 *
 * - **What it draws:** the band-0 trees (band byte 0, bands.ts) of every species with a `near.glb`, as thin instances:
 *   one mesh per (species, LOD0 material): bark and leaves, so 2 draws per species with a tree in band 0 (a species with
 *   two leaf sprites, the willow's leaf + strand, 3). Plants have no overlay. A mesh at count 0 is hidden, never drawn
 *   at the origin (TREES F13f). The overlay never casts (§W3.6: the merged LOD1 does) and is not pickable.
 * - **Same shading as the merged tiers:** the LOD0 geometry goes through the region batch's own merge (merge-core
 *   `mergeGroup`: the species' wind data as `sroTreeW`, UV2 packed with the material's table slot) once per species, and
 *   draws with table materials made by the batch's recipe (T12-M's `TreeMaterials` on the batch's table: the surface
 *   plugin's SRO_TABLE, the foliage plugin's tree slots), so LOD0 and LOD1 meet with the same lighting, wind and
 *   translucency. Each instance's matrix is the tree's species matrix (swap.ts `swapMatrixTo`), whose translation is the
 *   root the merged vertices bend around.
 * - **The per-instance tint (§W3.4):** a tinted tree's leaves read another table slot. Per instance one float,
 *   `sroTint` (a thin-instance buffer), is added to `uv2.y` in the vertex stage (`SroTreeTintPlugin`; the table decode
 *   reads the slot from floor(uv2 / 2)), so every tint of a species draws in the same draw. No varying (uv2Updated
 *   flows into vMainUV2, which the table already declares), no uniform, no sampler.
 * - **Loading:** a species' overlay loads when its first swapped placement gets a slot: `near.glb` + `near.json` (the
 *   converter copies them beside `far.glb`), its materials converted like any model's, their table slots (and the tint
 *   slots, T12-M's `TreeTints`) acquired and uploaded before the species counts as ready. Until then its trees stay mid
 *   (the merged LOD1 stands in), so nothing is ever missing. Unused for IDLE_DROP_S, it goes.
 * - **Warm-up (D25):** a warm-up hook compiles every loaded overlay mesh's effect (and holds the warm-up while a
 *   species loads), so the first tree entering band 0 compiles nothing in play.
 */
import {
  Material,
  MaterialPluginBase,
  Mesh,
  ShaderLanguage,
  VertexBuffer,
  type AbstractMesh,
  type AssetContainer,
  type BaseTexture,
  type MaterialDefines,
  type PBRMaterial,
  type Scene,
} from '@babylonjs/core'
import { keyOf } from '../../../texpipe/src/format.ts'
import type { WorldModel } from '../../../convert/src/world/manifest.ts'
import { mergeGroup, type MergeGroupJob, type MergeModels } from '../batch/merge-core.ts'
import type { BatchTableEntry, BatchTables } from '../batch/region-batch.ts'
import { TreeMaterials, treeKeyName, treeKeyOf, type TreeKey } from '../batch/trees.ts'
import type { ConvertedMaterials, MaterialBatchRecord, ObjectMaterials, SidecarLite } from '../materials.ts'
import { extractModelGeometry, type PrimitiveGeometry } from '../model-cache.ts'
import { WORLD_OBJECT_LAYER, loadGlb, prepareStatic } from '../objects.ts'
import { FOLIAGE_TREEW_KIND, type PbrFoliage } from '../pbr/foliage-plugin.ts'
import { addWarmupHook } from '../warmup-hooks.ts'
import type { Assets } from '../assets.ts'
import { nearFilesOf, type TreeTintsLike } from './swap.ts'

// ---- the tint plugin ----------------------------------------------------------------------------------------------

/** The thin-instance buffer of an overlay instance's tint (the uv2.y offset of its tint's table slot). */
export const TREE_TINT_KIND = 'sroTint'
export const SRO_TREE_TINT_PLUGIN = 'SroTreeTint'
/** The plugin's one define (on for a mesh carrying the `sroTint` buffer). */
export const TREE_TINT_DEFINES: readonly string[] = ['SRO_TREE_TINT']

const TINT_DEFS_WGSL = `#ifdef SRO_TREE_TINT
attribute ${TREE_TINT_KIND}: f32;
#endif
`
const TINT_DEFS_GLSL = `#ifdef SRO_TREE_TINT
attribute float ${TREE_TINT_KIND};
#endif
`
const TINT_UV2_WGSL = `#ifdef SRO_TREE_TINT
#ifdef UV2
uv2Updated.y += vertexInputs.${TREE_TINT_KIND};
#endif
#endif
`
const TINT_UV2_GLSL = `#ifdef SRO_TREE_TINT
#ifdef UV2
uv2Updated.y += ${TREE_TINT_KIND};
#endif
#endif
`

/** The tint plugin's injection points (vertex only; the fragment is untouched). */
export function treeTintCode(stage: 'vertex' | 'fragment', lang: 'wgsl' | 'glsl'): Readonly<Record<string, string>> | null {
  if (stage !== 'vertex') return null
  const w = lang === 'wgsl'
  return { CUSTOM_VERTEX_DEFINITIONS: w ? TINT_DEFS_WGSL : TINT_DEFS_GLSL, CUSTOM_VERTEX_UPDATE_NORMAL: w ? TINT_UV2_WGSL : TINT_UV2_GLSL }
}

/** Whether a mesh carries the per-instance tint (the `sroTint` buffer). */
export function hasTreeTint(mesh: AbstractMesh | null | undefined): boolean {
  return !!mesh && !!mesh.getVertexBuffer?.(TREE_TINT_KIND)
}

/**
 * The overlay's per-instance tint (see the file comment): `uv2.y += sroTint` in the vertex stage, on meshes with the
 * `sroTint` buffer only. An attribute, no uniform, no sampler (it shares a material with the surface and foliage
 * plugins without any name in common).
 */
export class SroTreeTintPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, SRO_TREE_TINT_PLUGIN, 270, { SRO_TREE_TINT: false }, true, true)
  }

  override getClassName(): string {
    return 'SroTreeTintPlugin'
  }

  /** WGSL and GLSL both (the base class says GLSL only). */
  override isCompatible(_language: ShaderLanguage): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    ;(defines as unknown as { SRO_TREE_TINT: boolean }).SRO_TREE_TINT = hasTreeTint(mesh)
  }

  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
    if (hasTreeTint(mesh)) attributes.push(TREE_TINT_KIND)
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    const code = treeTintCode(shaderType === 'vertex' ? 'vertex' : 'fragment', language === ShaderLanguage.WGSL ? 'wgsl' : 'glsl')
    return code ? { ...code } : null
  }
}

/** The tint plugin of a material, or null. */
export function treeTintPluginOf(mat: Material | null | undefined): SroTreeTintPlugin | null {
  return (mat?.pluginManager?.getPlugin(SRO_TREE_TINT_PLUGIN) as SroTreeTintPlugin | null | undefined) ?? null
}

// ---- one species' overlay ---------------------------------------------------------------------------------------

/** A species' overlay set unused this long is dropped (s): walking along a region edge must not reload it. */
export const IDLE_DROP_S = 20

/** A species' LOD0 as loaded (a test hands in its own container). */
export interface NearModel {
  container: AssetContainer
  sidecar: SidecarLite | null
  /** The model path the materials are converted for (the `near.glb` path). */
  path: string
}

/** How long a species' LOD0 looks for its far.glb sprite (the batch converts it), and how often (ms). */
const FAR_SPRITE_WAIT_MS = 60_000
const SPRITE_POLL_MS = 250

/** A record's own albedo texture (its material's), or null. */
function ownAlbedo(record: MaterialBatchRecord): BaseTexture | null {
  const m = record.material as { albedoTexture?: BaseTexture | null; diffuseTexture?: BaseTexture | null }
  return m.albedoTexture ?? m.diffuseTexture ?? null
}

/** The converted far.glb record with the same texture key as a LOD0 record and an albedo texture (TRL-1), or null. */
function farSprite(materials: ObjectMaterials, near: MaterialBatchRecord): MaterialBatchRecord | null {
  if (!near.texture) return null
  const key = keyOf(near.texture)
  for (const m of materials.materials) {
    const r = materials.batchRecord(m)
    if (!r || r === near || !r.texture || keyOf(r.texture) !== key) continue
    if (ownAlbedo(r)) return r
  }
  return null
}

/** Loads a species' LOD0 (default: `near.glb` + `near.json` beside its `far.glb`). null: the species has none. */
export type NearLoader = (species: WorldModel) => Promise<NearModel | null>

/** The default loader: the export's `models/trees/<id>/near.glb` and its sidecar. */
export function assetNearLoader(scene: Scene, assets: Assets): NearLoader {
  return async species => {
    const files = nearFilesOf(species)
    if (!files) return null
    const [container, sidecar] = await Promise.all([
      loadGlb(scene, assets, files.glb),
      assets.json<SidecarLite>(files.sidecar).catch(() => null),
    ])
    return { container, sidecar, path: files.glb }
  }
}

/** What the species sets are built with (the batch's table and the overlay's own table materials). */
export interface OverlayContext {
  readonly scene: Scene
  readonly materials: ObjectMaterials
  readonly tables: BatchTables
  /** The overlay's table materials (one per tree key), with the tint plugin. */
  material(k: Readonly<TreeKey>): PBRMaterial
  readonly tints: TreeTintsLike | null
  readonly load: NearLoader
}

/** One overlay mesh: a species' LOD0 primitives of one material. */
interface OverlayMesh {
  readonly mesh: Mesh
  /** Per tint k (0 = the species' own): the uv2.y offset (2 × the tint slot − 2 × the base slot); null: no tints. */
  readonly deltas: Float32Array | null
  /** Its per-instance tint buffer (with `deltas` only). */
  tint: Float32Array | null
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

/** The far.json / near.json tint list (the tree tool's build.ts). */
interface SidecarTrees {
  trees?: { tints?: unknown[] }
}

/** A species' overlay: loads once, then holds the instance lists of its band-0 trees. */
export class SpeciesOverlay {
  state: 'loading' | 'ready' | 'failed' | 'disposed' = 'loading'
  readonly meshes: OverlayMesh[] = []
  /** Entries using it (bands' slot entries), counted by the near field at every refill. */
  users = 0
  /** Seconds without users. */
  idle = 0
  /** Instances held after the last commit (drawn when > 0). */
  count = 0
  /** Triangles of one instance (all meshes). */
  triangles = 0
  private mats = new Float32Array(0)
  private tints = new Uint8Array(0)
  /** Instances the meshes' buffers hold (reserve). */
  private cap = 0
  private n = 0
  private entries: BatchTableEntry[] = []
  private near: NearModel | null = null
  private converted: ConvertedMaterials | null = null
  readonly ready: Promise<void>

  constructor(readonly species: WorldModel, private readonly ctx: OverlayContext, onReady: () => void) {
    this.ready = this.build().then(() => {
      if (this.state === 'loading') this.state = 'ready'
      onReady()
    }, err => {
      if (this.state !== 'disposed') {
        console.warn('[trees] no LOD0 overlay for', this.species.source, err)
        this.state = 'failed'
        for (const { mesh } of this.meshes.splice(0)) mesh.dispose(false, false)
        this.releaseLoaded()
      }
      onReady()
    })
  }

  private async build(): Promise<void> {
    const ctx = this.ctx
    const near = await ctx.load(this.species)
    if (this.gone()) {
      near?.container.dispose()
      return
    }
    if (!near) throw new Error('the species has no near.glb')
    this.near = near
    const converted = await ctx.materials.convert(near.container, near.sidecar, false, { model: near.path, source: this.species.source, kind: 'static' })
    this.converted = converted
    if (this.gone()) return this.releaseLoaded()
    const prep = prepareStatic(near.container)
    const geo = extractModelGeometry(prep)
    // The LOD0 primitives are tier 0, so model-cache.ts exported no TEXCOORD_2 (flutter, crown AO): read it here.
    for (const p of geo.primitives) {
      if (p.uvs3) continue
      const n = Math.floor(p.positions.length / 3)
      const d = prep.geometry[p.mesh]?.getVerticesData(VertexBuffer.UV3Kind)
      p.uvs3 = d && d.length >= n * 2 ? Float32Array.from({ length: n * 2 }, (_, i) => d[i]!) : null
    }
    // The table slots of each material, and of its tints (T12-M's tinted records: a slot of their own).
    const tintCount = Math.max(0, ((near.sidecar as SidecarTrees | null)?.trees?.tints?.length ?? 0))
    if (tintCount && ctx.tints) await ctx.tints.load(this.species)
    if (this.gone()) return this.releaseLoaded()
    const groups = new Map<Material, { record: MaterialBatchRecord; prims: number[] }>()
    geo.primitives.forEach((p, i) => {
      const record = ctx.materials.batchRecord(p.material)
      if (!p.material || !record) throw new Error(`primitive ${p.name} has no batch record`)
      const g = groups.get(p.material)
      if (g) g.prims.push(i)
      else groups.set(p.material, { record, prims: [i] })
    })
    // TRL-1: near.glb carries the texture keys only (TREES WF19); a material with no albedo of its own reads the
    // species' far.glb sprite of the same key (or the TX-R map that replaced it), so the overlay is never drawn with
    // solid cards when TX-R has nothing to swap in (Textures: Retail) or has not swapped yet (the first seconds).
    // The far.glb is the batch's (converted when the species' first region merges, possibly after this load): a sprite
    // that is not there yet is looked up lazily, and its slot refreshed once it appears (watchSprites).
    const pending: MaterialBatchRecord[] = []
    for (const { record } of groups.values()) {
      if (ownAlbedo(record) || record.albedoFallback || !record.texture) continue
      let far = farSprite(ctx.materials, record)
      if (!far) pending.push(record)
      record.albedoFallback = () => {
        far ??= farSprite(ctx.materials, record)
        return far ? ownAlbedo(far) : null
      }
    }
    if (pending.length) this.watchSprites(pending)
    const planned: Array<{ record: MaterialBatchRecord; prims: number[]; entry: BatchTableEntry; deltas: Float32Array | null }> = []
    for (const { record, prims } of groups.values()) {
      const entry = this.acquire(record)
      if (!entry) throw new Error(`the table refused ${record.name}`)
      let deltas: Float32Array | null = null
      if (tintCount && ctx.tints) {
        const d = new Float32Array(tintCount + 1)
        for (let k = 1; k <= tintCount; k++) {
          const r = ctx.tints.recordFor(this.species, record, k)
          if (r === record) continue
          const e = this.acquire(r)
          if (e) d[k] = 2 * (e.slot - entry.slot)
        }
        if (d.some(v => v !== 0)) deltas = d
      }
      planned.push({ record, prims, entry, deltas })
    }
    const ready = ctx.tables.ready?.(this.entries)
    if (ready && typeof (ready as Promise<void>).then === 'function') await ready
    if (this.gone()) return this.releaseLoaded()
    const models: MergeModels = id => (id === 0 ? { primitives: geo.primitives } : undefined)
    // The scene's default side orientation (region-batch.ts defaultOrientation).
    const fallback = ctx.scene.useRightHandedSystem ? Material.ClockWiseSideOrientation : Material.CounterClockWiseSideOrientation
    for (const { record, prims, entry, deltas } of planned) {
      const key = treeKeyOf(record)
      const orient = (p: PrimitiveGeometry) => record.material.sideOrientation ?? p.sideOrientation ?? fallback
      const first = orient(geo.primitives[prims[0]!]!)
      const job: MergeGroupJob = {
        key: `${treeKeyName(key)}|${record.name}`,
        pieces: prims.map(i => ({
          model: 0, primitive: i, matrices: IDENTITY, pivots: null, twoSided: record.twoSided, flip: orient(geo.primitives[i]!) !== first,
          uv2: { slot: entry.slot, layer: entry.layer, scale: entry.scale, offsetU: entry.offsetU, offsetV: entry.offsetV }, tier: 0, wind: true,
        })),
        pivotSize: 0,
        proxy: false,
        treeW: true,
        leaf: key.leaf,
      }
      const g = mergeGroup(job, models)
      if (!g) continue
      const mesh = new Mesh(`trees:near:${this.species.index}:${record.name}`, ctx.scene)
      mesh.setVerticesData(VertexBuffer.PositionKind, g.positions, false, 3)
      mesh.setVerticesData(VertexBuffer.NormalKind, g.normals, false, 3)
      if (g.uvs) mesh.setVerticesData(VertexBuffer.UVKind, g.uvs, false, 2)
      if (g.uvs2) mesh.setVerticesData(VertexBuffer.UV2Kind, g.uvs2, false, 2)
      if (g.treeW) mesh.setVerticesBuffer(new VertexBuffer(ctx.scene.getEngine(), g.treeW, FOLIAGE_TREEW_KIND, { updatable: false, size: 4, stride: 4, type: VertexBuffer.UNSIGNED_BYTE, normalized: true }))
      mesh.setIndices(g.indices, g.vertices)
      // The material first (region-batch.ts groupMesh: the setter would null a set orientation hint).
      mesh.material = ctx.material(key)
      mesh.sideOrientation = first
      this.triangles += g.triangles
      this.meshes.push({ mesh: setupOverlayMesh(mesh), deltas, tint: null })
    }
    if (!this.meshes.length) throw new Error('the LOD0 has no triangles')
    // The source meshes are not drawn (the overlay holds the merged copy): their geometry goes now; the converted
    // materials stay (the table's slots read them) until the set goes.
    const sources = new Set(prep.geometry)
    for (const m of sources) m.dispose(false, false)
    near.container.meshes = near.container.meshes.filter(m => !sources.has(m as Mesh))
    this.reserve(1)
  }

  /**
   * TRL-1: the LOD0 records whose far sprite was not converted yet when their slots were made: checked every
   * SPRITE_POLL_MS (up to FAR_SPRITE_WAIT_MS); once there, the slot is made again from it (the table's map refresh).
   */
  private watchSprites(records: MaterialBatchRecord[]): void {
    const materials = this.ctx.materials
    let waited = 0
    const timer = setInterval(() => {
      waited += SPRITE_POLL_MS
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i]!
        if (!farSprite(materials, r)) continue
        records.splice(i, 1)
        if (!this.gone()) materials.onMapsChanged.notifyObservers(r)
      }
      if (!records.length || this.gone() || waited >= FAR_SPRITE_WAIT_MS) clearInterval(timer)
    }, SPRITE_POLL_MS)
    ;(timer as { unref?: () => void }).unref?.()
  }

  /** Disposed meanwhile (an await may have let the part go). */
  private gone(): boolean {
    return this.state === 'disposed'
  }

  private acquire(record: MaterialBatchRecord): BatchTableEntry | null {
    let e: BatchTableEntry | null = null
    try {
      e = this.ctx.tables.acquire(record)
    } catch (err) {
      console.warn('[trees] table slot refused', record.name, err)
    }
    if (e) this.entries.push(e)
    return e
  }

  /** Makes room for `n` instances: the shared matrix list and each tinted mesh's tint list grow, buffers re-set. */
  private reserve(n: number): void {
    if (n <= this.cap) return
    const cap = Math.max(n, Math.ceil(this.cap * 1.5), 4)
    const mats = new Float32Array(cap * 16)
    mats.set(this.mats.subarray(0, this.n * 16))
    this.mats = mats
    const tints = new Uint8Array(cap)
    tints.set(this.tints.subarray(0, this.n))
    this.tints = tints
    for (const m of this.meshes) {
      const was = m.mesh.thinInstanceCount
      m.mesh.thinInstanceSetBuffer('matrix', this.mats, 16, false)
      if (m.deltas) {
        m.tint = new Float32Array(cap)
        m.mesh.thinInstanceSetBuffer(TREE_TINT_KIND, m.tint, 1, false)
      }
      m.mesh.thinInstanceCount = Math.min(was, cap)
    }
    this.cap = cap
  }

  /** Starts a new instance list. */
  begin(): void {
    this.n = 0
  }

  /** Adds an instance: its species matrix (16 floats at `m[o]`) and its tint. */
  push(m: ArrayLike<number>, o: number, tint: number): void {
    if (this.state !== 'ready') return
    if (this.n >= this.cap) this.reserve(this.n + 1)
    const at = this.n * 16
    for (let i = 0; i < 16; i++) this.mats[at + i] = m[o + i]!
    this.tints[this.n] = tint
    this.n++
  }

  /** Writes the list to the meshes (`visible` false: none drawn). Returns the draws (meshes drawn). */
  commit(visible: boolean): number {
    const n = this.state === 'ready' && visible ? this.n : 0
    this.count = n
    let draws = 0
    for (const m of this.meshes) {
      const mesh = m.mesh
      if (n && m.deltas && m.tint) {
        const d = m.deltas
        for (let i = 0; i < n; i++) m.tint[i] = d[this.tints[i]!] ?? 0
      }
      mesh.thinInstanceCount = n
      // Count 0: hidden (TREES F13f: a thin-instance mesh at count 0 must never draw its base at the origin).
      mesh.isVisible = n > 0
      if (n) {
        mesh.thinInstanceBufferUpdated('matrix')
        if (m.deltas) mesh.thinInstanceBufferUpdated(TREE_TINT_KIND)
        mesh.thinInstanceRefreshBoundingInfo(false)
        draws++
      }
    }
    return draws
  }

  /** The warm-up: compiles every mesh's effect (one hidden instance while it has none); true when all are ready. */
  warm(): boolean {
    if (this.state !== 'ready') return true
    let ok = true
    for (const { mesh } of this.meshes) {
      const had = mesh.thinInstanceCount
      if (!had) mesh.thinInstanceCount = 1
      try {
        if (!mesh.isReady(true)) ok = false
      } finally {
        if (!had) mesh.thinInstanceCount = 0
      }
    }
    return ok
  }

  private releaseLoaded(): void {
    for (const e of this.entries.splice(0)) {
      try {
        this.ctx.tables.release(e)
      } catch {
        // the table went with its batch part
      }
    }
    if (this.converted) {
      try {
        this.ctx.materials.release(this.converted)
      } catch {
        // released with the world
      }
      this.converted = null
    }
    this.near?.container.dispose()
    this.near = null
  }

  dispose(): void {
    if (this.state === 'disposed') return
    this.state = 'disposed'
    for (const { mesh } of this.meshes.splice(0)) mesh.dispose(false, false)
    this.releaseLoaded()
  }
}

/** The common set-up of an overlay mesh (count 0, hidden; world object layer; not pickable; receives shadows). */
function setupOverlayMesh(mesh: Mesh): Mesh {
  mesh.isPickable = false
  mesh.receiveShadows = true
  mesh.metadata = { sroWorld: 'object', sroTree: true, sroTreeOverlay: true }
  mesh.layerMask |= WORLD_OBJECT_LAYER
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(16), 16, false)
  mesh.thinInstanceCount = 0
  mesh.isVisible = false
  mesh.freezeWorldMatrix()
  mesh.setEnabled(true)
  return mesh
}

// ---- the near field -----------------------------------------------------------------------------------------------

/** What the near field is made with. */
export interface NearFieldHost {
  readonly scene: Scene
  readonly materials: ObjectMaterials
  readonly foliage: PbrFoliage | null
  readonly load: NearLoader
}

/** The overlay of every species in use, on one batch's table (made again with the trees part). */
export class NearField {
  private readonly sets = new Map<number, SpeciesOverlay>()
  private treeMats: TreeMaterials | null = null
  private tables: BatchTables | null = null
  private tints: TreeTintsLike | null = null
  private readonly warmOff: () => void
  private disposed = false
  /** Draws after the last commit. */
  draws = 0
  /** Instances after the last commit. */
  instances = 0
  /** Set by a species that finished loading (the part refills then). */
  changed = false

  constructor(readonly host: NearFieldHost) {
    this.warmOff = addWarmupHook(host.scene, () => this.warm())
  }

  /**
   * Binds the batch's table and tints (the first species needs them; the trees part lives and dies with one batch).
   * False when there is no table (the batch is not in merge mode): no overlay at all.
   */
  bind(tables: BatchTables | null, tints: TreeTintsLike | null, breeze: number | null): boolean {
    if (this.disposed || !tables) return false
    if (this.tables && this.tables !== tables) return false
    if (!this.tables) {
      this.tables = tables
      this.tints = tints
      this.treeMats = new TreeMaterials(this.host.scene, this.host.materials, tables, this.host.foliage, breeze ?? undefined)
    } else if (breeze !== null && this.treeMats && this.treeMats.breeze !== breeze) {
      this.treeMats.breeze = breeze
    }
    return true
  }

  /** The overlay materials' minimum breeze (the merged groups', TreeMaterials.breeze). */
  setBreeze(v: number): void {
    if (this.treeMats && this.treeMats.breeze !== v) this.treeMats.breeze = v
  }

  /** The overlay's table material of a tree key (made on first use, with the tint plugin). */
  private material(k: Readonly<TreeKey>): PBRMaterial {
    const mat = this.treeMats!.get(k)
    if (!treeTintPluginOf(mat)) {
      new SroTreeTintPlugin(mat)
      mat.metadata = { ...(mat.metadata as object | null), sroTreeOverlay: true }
    }
    return mat
  }

  /** The overlay set of a species (made, and its load started, on first use); null without a table. */
  want(species: WorldModel): SpeciesOverlay | null {
    let set = this.sets.get(species.index)
    if (set) return set
    if (this.disposed || !this.tables) return null
    const tables = this.tables
    set = new SpeciesOverlay(species, {
      scene: this.host.scene, materials: this.host.materials, tables, tints: this.tints, load: this.host.load,
      material: k => this.material(k),
    }, () => {
      this.changed = true
    })
    this.sets.set(species.index, set)
    return set
  }

  /** The set of a species index (null: none made). */
  get(index: number): SpeciesOverlay | null {
    return this.sets.get(index) ?? null
  }

  /** Every set (loading, ready or failed). */
  all(): IterableIterator<SpeciesOverlay> {
    return this.sets.values()
  }

  /** Ages the sets without users and drops those idle for IDLE_DROP_S (not while loading). */
  age(dt: number): void {
    for (const [i, s] of this.sets) {
      if (s.users > 0 || s.state === 'loading') {
        s.idle = 0
        continue
      }
      s.idle += Math.max(0, dt)
      if (s.idle < IDLE_DROP_S) continue
      s.dispose()
      this.sets.delete(i)
    }
  }

  /** Every overlay mesh. */
  meshes(): AbstractMesh[] {
    const out: AbstractMesh[] = []
    for (const s of this.sets.values()) for (const m of s.meshes) out.push(m.mesh)
    return out
  }

  /** The warm-up hook: 'loading' while a species loads, else whether every loaded overlay effect is compiled. */
  warm(): boolean | 'loading' {
    if (this.disposed) return true
    let ok = true
    for (const s of this.sets.values()) {
      if (s.state === 'loading') return 'loading'
      if (!s.warm()) ok = false
    }
    return ok
  }

  /** Counters: species sets by state, triangles per drawn instance set. */
  stats(): { species: number; speciesReady: number; speciesLoading: number; speciesFailed: number; overlayMeshes: number } {
    let ready = 0, loading = 0, failed = 0, meshes = 0
    for (const s of this.sets.values()) {
      if (s.state === 'ready') ready++
      else if (s.state === 'loading') loading++
      else if (s.state === 'failed') failed++
      meshes += s.meshes.length
    }
    return { species: this.sets.size, speciesReady: ready, speciesLoading: loading, speciesFailed: failed, overlayMeshes: meshes }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.warmOff()
    for (const s of this.sets.values()) s.dispose()
    this.sets.clear()
    this.treeMats?.dispose()
    this.treeMats = null
    this.tables = null
    this.tints = null
  }
}
