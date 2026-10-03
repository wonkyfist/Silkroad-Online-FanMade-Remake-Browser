/**
 * The region batch (docs/BATCHING.md §3.1, §3.7, §3.8, §4.5; docs/WAVE_PLAN6.md §6.1 BT-M): the RegionBatcher behind
 * WorldObjects' claim. Per streamed region it takes the static placements of every non-foliage model, merges them in
 * the merge worker (merge-core.ts) into world-space groups, creates one mesh per group in budgeted stream jobs, and
 * hands the region's listeners one `batched` event with the meshes, the worker's shadow proxy, the cut-out casters and
 * the material slots (NL's lamp slots). Unload, release and dispose free every mesh, slot and worker copy.
 *
 * **Two kinds of group** (one region may hold both):
 * - **Table groups** (the design, §3.1–§3.4): with BT-A's material table (`BatchTables`), a piece whose material the
 *   table holds goes into the region's group for (LOD group, opaque | cut-out, cloth sheen, lamp): 2–6 meshes a region.
 *   UV2 packs (lightmap layer, slot) (§3.3); two-sided pieces are emitted twice and the group draws single-sided. Every
 *   group of one key draws with one **group material of its own**, shared by every region (≈ 8 in the world, Q12),
 *   made here and switched to the table by `BatchTables.bindMaterial` (BT-P's `SRO_TABLE`). Converted materials are
 *   never modified (§4.5 finding 3: a representative's culling leaked into every other user).
 * - **Material groups**: a piece the table cannot take (no table at all, a Classic / unlit / alpha-blended material,
 *   §3.7 "stay per model"; a lamp when the table has no lamp group, scope cut 4; a retail emissive, whose ambient-tied
 *   self-light PbrSurfaces drives on its converted material; a slot the table refused) draws with
 *   its **converted material, unchanged**, merged per (region, LOD group, sub-chunk, material): the same image as the
 *   thin-instance chunk it replaces, the same number of draws or fewer. Without a table every piece is one of these
 *   (`mode: 'material'`), which is how the merge is checked against today's image (the A/B) before BT-A and BT-P land.
 *
 * **Foliage (BT-T, trees.ts):** with a table, foliage models merge into the region's tree groups (leaf | wood, cut-out |
 * opaque) whose vertices carry each tree's root as the pivot attribute (their wind bends around it), and a skinned
 * foliage model loads its static variant (`modelFor`); without a table they are not claimed (today's chunks and clones).
 *
 * **The new trees (wave 12, T12-M; TREES §W3.2–§W3.6, WF8, WF10–WF12, WF15):** with the swap source a swapped retail
 * model loads its species (trees.ts `modelFor`) and is always a tree claim. Its placements merge with the fit and the
 * trunk offset folded into their matrices; its LOD1 and LOD2 (a plant's two tiers) go into the same tree groups as the
 * retail trees (the draws per region stay wave 10's), tier-2 pieces last. A group holding a swapped piece carries the
 * 4-float pivot (root, band slot × 4 + tier; a retail tree's tier 0) and `sroTreeW` (unorm8x4, `FOLIAGE_TREEW_KIND`), and
 * its swapped pieces take the white lightmap quadrant (their TEXCOORD_1 is wind data). A tinted retail model's leaves
 * take their tint's record (trees.ts `TreeTints`; the plan waits for its image). On a preset that casts foliage the
 * worker also returns the cut-out caster's arrays (LOD1 only, `RegionBatch.casterData`), which render/shadows.ts
 * uploads as they are; the group meshes keep their LOD1 prefix (`metadata.sroCasterPrefix`) for the main-thread copy.
 *
 * **Cloth (wave 11, W11-S; TOWN_LIFE §5.1, F1):** a table piece whose material carries the converter's cloth record
 * (`MaterialBatchRecord.cloth`) gives its `+sheen` group a 4-float per-piece pivot (CLOTH_PIVOT_SIZE: pin height, hanging
 * height, kind, phase; `clothPivots`), and the group material takes the foliage plugin's cloth slot (`SRO_CLOTH_WIND`,
 * TL-M's chunk). The other pieces of that group carry a zero pivot (kind 0: no sway). No cloth record anywhere: the
 * `+sheen` groups merge exactly as before (no pivot, no plugin).
 *
 * **What is not claimed:** models tagged 'scatter' / 'life' / 'ocean' / 'town' (WorldObjects never offers them), the
 * whole-world load (no cache entry), and models whose materials are not ObjectMaterials'.
 *
 * **Draw ranges (§3.8, F11):** each group mesh keeps the spheres of the thin-instance chunks it replaces (one per model
 * and cell: the region for group 2, today's 96 m sub-chunks for group 3) and is shown while one of them is in range
 * (`distance − radius < 202 m` or `48 m × rangeScale`). A group therefore appears when the first chunk it replaces
 * would, and with it the group's other models (the whole group draws: the vertex collapse of §3.8 is not built, scope
 * cut 5). The scale is WorldObjects' live one (Options' sight, the create screen's 0.6), forwarded through
 * `setRangeScale`; `setLod(false)` (the viewer's LOD toggle) turns the ranges off.
 *
 * **Shadows (§3.9, F10):** the proxy is the region's opaque group-2 pieces from the same worker run (no main-thread
 * `mergeInstances`); the cut-out casters are the cut-out and non-opaque group meshes (a material group casts with its
 * converted material's alpha test, as the chunks did; a table cut-out group casts solid until BT-S's depth shader).
 */
import {
  Material,
  Matrix,
  Mesh,
  PBRMaterial,
  Quaternion,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  type AbstractMesh,
  type Scene,
} from '@babylonjs/core'
import type { WorldModel, WorldPlacement } from '../../../convert/src/world/manifest.ts'
import { LAMP_MATERIAL, batchClass, clothKindCode, type ClothRecord, type MaterialBatchRecord, type ObjectMaterial, type ObjectMaterials } from '../materials.ts'
import { geometryOf, type ModelGeometry } from '../model-cache.ts'
import { GROUP_RANGE_M, WORLD_OBJECT_LAYER } from '../objects.ts'
import { isFoliageModel } from '../pbr/classes.ts'
import { FOLIAGE_MIN_BREEZE, FOLIAGE_TREEW_KIND, type PbrFoliage } from '../pbr/foliage-plugin.ts'
import { placementScale } from '../placement-scale.ts'
import { SroSurfacePlugin } from '../pbr/surface-plugin.ts'
import { useWindowedLightFalloff } from '../render/babylon-fixes.ts'
import { CASTER_DROP_MARGIN_M, SHADOW_PROXY_LAYER, isOpaqueMaterial } from '../render/shadows.ts'
import type { CachedModel } from '../region-chunk.ts'
import { placementKey } from '../trees/types.ts'
import {
  MergeHost,
  type MergeGroupJob,
  type MergePiece,
  type MergePrimitive,
  type MergeRequest,
  type MergeResponse,
  type MergeResult,
  type CasterPrefix,
  type MergedCaster,
  type MergedGroup,
} from './merge-core.ts'
import { remasterVariantOf } from './remaster.ts'
import {
  TREE_PIVOT4_SIZE,
  TREE_PIVOT_SIZE,
  TreeBatch,
  bandSlotOf,
  foldSwap,
  swapPivots,
  treeKeyName,
  treeKeyOf,
  treePivots,
  widenPivots,
  type TreeKey,
  type TreeOptions,
} from './trees.ts'
import type {
  BatchClass,
  BatchCommitContext,
  BatchHost,
  BatchModelSource,
  BatchPart,
  BatchRegion,
  BatchSlot,
  BatchWorkerFactory,
  BatchWorkerLike,
  RegionBatch,
  TreeSwap,
} from './types.ts'

/** The pivot attribute's vertex-buffer kind (BT-T's trees; BT-P's `SRO_FOL_PIVOT` reads it). */
export const BATCH_PIVOT_KIND = 'sroPivot'
/** W11-S: floats per vertex of a cloth group's pivot (pin height, hanging height, kind code, phase; SRO_CLOTH_WIND). */
export const CLOTH_PIVOT_SIZE = 4
/** Group-3 sub-chunk size (m): objects.ts' CHUNK_M[3], so group-3 ranges stay today's. */
export const G3_CELL_M = 96
/** A main-thread job longer than this (ms) is counted and listed (`slowest`): Medium's stream frame budget. */
export const SLOW_JOB_MS = 4
/** Model geometry the worker keeps (LRU, bytes). */
export const WORKER_CACHE_BYTES = 64 * 1024 * 1024

// ---- the table seam (BT-A's material table and atlases, BT-P's SRO_TABLE) ------------------------------------------

/** A converted material's place in the table: its slot and its lightmap's place in the lightmap array (§3.2, F7). */
export interface BatchTableEntry {
  readonly slot: number
  /** The lightmap array layer (a material without a lightmap: layer 0, the white quadrant). */
  readonly layer: number
  /** UV2 → the layer: uv2 × scale + offset (a 128² / 64² lightmap's quadrant: scale 0.5; a 256² layer: 1, 0). */
  readonly scale: number
  readonly offsetU: number
  readonly offsetV: number
}

/** The key of a table group's material (≈ 8 in the world; nothing in it is per region, Q12). */
export interface GroupMaterialKey {
  /** Alpha-tested (the slot's own cut-off comes from the table). */
  cutout: boolean
  /** Cloth sheen (a material define, `applyClassExtras`). */
  sheen: boolean
  /** The lamp group: NL's night emissive per slot (table texel 5, F9). */
  lamp: boolean
}

/**
 * The material table as the region batch uses it (BT-A: `batch/{table, atlas, lightmaps}.ts`; BT-P switches a group
 * material to it). Slots are reference-counted: every region holds one reference per material it merged.
 */
export interface BatchTables {
  /** False: NL's lamps are not merged into lamp groups (they draw in material groups; scope cut 4). */
  readonly lamps: boolean
  /** Takes a reference on the record's slot (and its cells); null: the table cannot hold it (a material group). */
  acquire(record: MaterialBatchRecord): BatchTableEntry | null
  /** Drops a reference; the slot, its cells and its lightmap quadrant go with the last. */
  release(entry: BatchTableEntry): void
  /** Resolves once the entries' cells are uploaded (the region's batch shows then); absent: ready at once. */
  ready?(entries: readonly BatchTableEntry[]): Promise<void> | void
  /** Texel 5: NL's night lamp colour × level for a slot (display-referred, like `emissiveColor`). */
  setEmissive(slot: number, r: number, g: number, b: number): void
  /** Switches a new group material to the table (BT-P's `SRO_TABLE`, BT-A's four textures). Called once per material. */
  bindMaterial(material: PBRMaterial, key: Readonly<GroupMaterialKey>): void
  /** Called when the batch part goes (the table may free what it made for it). */
  dispose?(): void
}

// ---- helpers --------------------------------------------------------------------------------------------------

type Point = { readonly x: number; readonly y: number; readonly z: number }
const ORIGIN: Point = { x: 0, y: 0, z: 0 }

/** Babylon's default side orientation of a new mesh in this scene (0 = clockwise in a right-handed scene). */
function defaultOrientation(scene: Scene): number {
  return scene.useRightHandedSystem ? Material.ClockWiseSideOrientation : Material.CounterClockWiseSideOrientation
}

/** The orientation a piece draws with today: its material's when set, else its source mesh's. */
function effectiveOrientation(mat: Material | null, prim: number | null, fallback: number): number {
  return mat?.sideOrientation ?? prim ?? fallback
}

/**
 * A placement's world matrix (objects.ts `placementMatrix`: T(position) R(rotation) S(scale); W12-SA S-SCALE: the
 * uniform scale, 1 when absent, which keeps every batch byte for byte).
 */
function placementMatrixTo(p: WorldPlacement, out: Float32Array, offset: number, tmp: Matrix): void {
  const s = placementScale(p)
  Matrix.ComposeToRef(s === 1 ? Vector3.OneReadOnly : new Vector3(s, s, s), Quaternion.FromArray(p.rotation), Vector3.FromArray(p.position), tmp)
  tmp.copyToArray(out, offset)
}

/** W12-SA (S-SCALE): the placements' scales when any differs from 1 (cloth pivots), else null (today's pivots). */
function scalesOf(list: readonly WorldPlacement[]): Float32Array | null {
  return list.some(p => placementScale(p) !== 1) ? Float32Array.from(list, placementScale) : null
}

/** A foliage model (BT-T's): its wind needs the per-instance pivot. */
/** A model's model-space bounds (min xyz, max xyz) over every primitive, cached per geometry. */
const boundsOf = new WeakMap<ModelGeometry, Float32Array>()
function modelBounds(g: ModelGeometry): Float32Array {
  let b = boundsOf.get(g)
  if (b) return b
  b = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
  for (const prim of g.primitives) {
    const p = prim.positions
    for (let i = 0; i + 2 < p.length; i += 3) for (let a = 0; a < 3; a++) {
      const v = p[i + a]!
      if (v < b[a]!) b[a] = v
      if (v > b[a + 3]!) b[a + 3] = v
    }
  }
  if (!(b[0]! <= b[3]!)) b.fill(0)
  boundsOf.set(g, b)
  return b
}

/**
 * The sphere (centre xyz, radius) of a model's placements in one cell: the world box of every instance's model box,
 * i.e. the bounds of the thin-instance chunk the batch replaces (objects.ts placeStatic).
 */
function chunkSphere(local: Float32Array, matrices: Float32Array): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let o = 0; o + 15 < matrices.length; o += 16) {
    for (let c = 0; c < 8; c++) {
      const x = local[c & 1 ? 3 : 0]!, y = local[c & 2 ? 4 : 1]!, z = local[c & 4 ? 5 : 2]!
      const wx = matrices[o]! * x + matrices[o + 4]! * y + matrices[o + 8]! * z + matrices[o + 12]!
      const wy = matrices[o + 1]! * x + matrices[o + 5]! * y + matrices[o + 9]! * z + matrices[o + 13]!
      const wz = matrices[o + 2]! * x + matrices[o + 6]! * y + matrices[o + 10]! * z + matrices[o + 14]!
      if (wx < x0) x0 = wx
      if (wx > x1) x1 = wx
      if (wy < y0) y0 = wy
      if (wy > y1) y1 = wy
      if (wz < z0) z0 = wz
      if (wz > z1) z1 = wz
    }
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2]
}

/** A primitive's model-space bounds (min xyz, max xyz), cached per positions array (the cloth pivots read them). */
const primBoundsOf = new WeakMap<object, Float32Array>()
function primitiveBounds(positions: ArrayLike<number> & object): Float32Array {
  let b = primBoundsOf.get(positions)
  if (b) return b
  b = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
  for (let i = 0; i + 2 < positions.length; i += 3) for (let a = 0; a < 3; a++) {
    const v = positions[i + a]!
    if (v < b[a]!) b[a] = v
    if (v > b[a + 3]!) b[a + 3] = v
  }
  if (!(b[0]! <= b[3]!)) b.fill(0)
  primBoundsOf.set(positions, b)
  return b
}

/** The smallest hanging height (m) a cloth pivot carries (a flat piece still sways a little). */
export const CLOTH_MIN_HEIGHT_M = 0.05

/**
 * W11-S (TOWN_LIFE §5.1, F1): the per-piece cloth pivots of one primitive at its instances (CLOTH_PIVOT_SIZE floats
 * each, world space): the pin height (`hanging` / `awning`: the piece's top; `tent`: its base; or the converter's
 * `pin`, from the model's space), the hanging height (at least CLOTH_MIN_HEIGHT_M), the kind code (clothKindCode) and
 * a phase in [0, 2π) from the piece's world centre (neighbouring flags do not flap in step). `local`: the primitive's
 * model-space bounds (min xyz, max xyz); `matrices`: 16 floats per instance (T R S, the merge's placement matrices);
 * `scales` (W12-SA S-SCALE): each instance's uniform scale for the converter's hanging height, null when all are 1.
 */
export function clothPivots(local: ArrayLike<number>, matrices: ArrayLike<number>, cloth: ClothRecord, scales: ArrayLike<number> | null = null): Float32Array {
  const n = Math.floor(matrices.length / 16)
  const out = new Float32Array(n * CLOTH_PIVOT_SIZE)
  const code = clothKindCode(cloth.kind)
  const x0 = local[0]!, y0 = local[1]!, z0 = local[2]!, x1 = local[3]!, y1 = local[4]!, z1 = local[5]!
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2
  const tau = Math.PI * 2
  for (let k = 0; k < n; k++) {
    const o = k * 16
    const m1 = matrices[o + 1]!, m5 = matrices[o + 5]!, m9 = matrices[o + 9]!, m13 = matrices[o + 13]!
    // The world y range of the model box under the instance's rotation.
    const lo = m13 + Math.min(m1 * x0, m1 * x1) + Math.min(m5 * y0, m5 * y1) + Math.min(m9 * z0, m9 * z1)
    const hi = m13 + Math.max(m1 * x0, m1 * x1) + Math.max(m5 * y0, m5 * y1) + Math.max(m9 * z0, m9 * z1)
    const wx = matrices[o]! * cx + matrices[o + 4]! * cy + matrices[o + 8]! * cz + matrices[o + 12]!
    const wz = matrices[o + 2]! * cx + matrices[o + 6]! * cy + matrices[o + 10]! * cz + matrices[o + 14]!
    let pin: number
    let height: number
    if (cloth.pin) {
      pin = m1 * cx + m5 * cloth.pin[0] + m9 * cz + m13
      // W12-SA (S-SCALE): the converter's hanging height is model space (the matrices carry the pin's scale already).
      height = scales ? cloth.pin[1] * scales[k]! : cloth.pin[1]
    } else {
      pin = cloth.kind === 'tent' ? lo : hi
      height = hi - lo
    }
    const ph = (wx * 12.9898 + wz * 78.233) % tau
    out[k * 4] = pin
    out[k * 4 + 1] = Math.max(CLOTH_MIN_HEIGHT_M, height)
    out[k * 4 + 2] = code
    out[k * 4 + 3] = ph < 0 ? ph + tau : ph
  }
  return out
}

function isFoliage(model: WorldModel, geometry: readonly { material: Material | null }[]): boolean {
  if (isFoliageModel(model.source)) return true
  return geometry.some(p => !!(p.material?.metadata as { sroFoliage?: boolean } | null)?.sroFoliage)
}

/** T12-M: the roots of folded swap matrices (each translation), TREE_PIVOT_SIZE floats per instance (no band). */
function rootPivots(matrices: Float32Array): Float32Array {
  const n = Math.floor(matrices.length / 16)
  const out = new Float32Array(n * 3)
  for (let k = 0; k < n; k++) {
    out[k * 3] = matrices[k * 16 + 12]!
    out[k * 3 + 1] = matrices[k * 16 + 13]!
    out[k * 3 + 2] = matrices[k * 16 + 14]!
  }
  return out
}

// ---- the merge worker client ----------------------------------------------------------------------------------

interface PendingMerge {
  groups: MergeGroupJob[]
  resolve: (r: MergeResult) => void
  reject: (e: Error) => void
}

interface SentModel {
  bytes: number
  /** Region builds that pinned it (`ensure` until `unpin`): never dropped meanwhile. */
  users: number
}

/**
 * Talks to the merge worker (or runs its handler in-process): sends each model's geometry once and keeps the worker's
 * copies within a byte budget (least recently used first, never one a region build has pinned), posts region merges
 * and resolves them. A worker that fails hands its pending merges to the in-process handler for good.
 */
export class MergeClient {
  private worker: BatchWorkerLike | null
  private readonly local = new MergeHost()
  private readonly pending = new Map<number, PendingMerge>()
  private readonly ids = new WeakMap<ModelGeometry, number>()
  /** Model ids the handler holds, oldest use first. */
  private readonly sent = new Map<number, SentModel>()
  private readonly geometries = new Map<number, ModelGeometry>()
  private seq = 0
  private nextId = 0
  private closed = false
  sentBytes = 0
  /** Merges answered by the worker / in-process. */
  readonly counts = { worker: 0, local: 0 }

  constructor(factory: BatchWorkerFactory | null, readonly cacheBytes = WORKER_CACHE_BYTES) {
    let w: BatchWorkerLike | null = null
    try {
      w = factory?.() ?? null
    } catch (err) {
      console.warn('[batch] merge worker unavailable; merging on the main thread:', err)
    }
    this.worker = w
    if (w) {
      w.onmessage = e => this.answer(e.data as MergeResponse)
      const withError = w as BatchWorkerLike & { onerror?: ((e: { message?: string; preventDefault?: () => void }) => void) | null }
      if ('onerror' in withError) {
        withError.onerror = e => {
          e.preventDefault?.()
          this.fail(e.message || 'worker error')
        }
      }
    }
  }

  /** Whether a worker (not the in-process handler) merges. */
  get usesWorker(): boolean {
    return this.worker !== null
  }

  /** Models whose geometry the handler holds. */
  get cachedModels(): number {
    return this.sent.size
  }

  /** The id of a model geometry (stable while the object lives). */
  idOf(g: ModelGeometry): number {
    let id = this.ids.get(g)
    if (id === undefined) {
      id = ++this.nextId
      this.ids.set(g, id)
    }
    return id
  }

  /**
   * Makes sure the handler holds `g` (a copy is posted now: call it inside a budgeted job) and pins it until `unpin`.
   * Returns its id.
   */
  ensure(g: ModelGeometry): number {
    const id = this.idOf(g)
    const had = this.sent.get(id)
    if (had) {
      // Most recent use last.
      this.sent.delete(id)
      this.sent.set(id, had)
      had.users++
      return id
    }
    this.sent.set(id, { bytes: g.bytes, users: 1 })
    this.geometries.set(id, g)
    this.sentBytes += g.bytes
    this.post({ t: 'models', models: [{ id, primitives: primitivesOf(g) }] })
    return id
  }

  /** Releases `ensure` pins (a region's merge is done or dropped); models beyond the budget may go then. */
  unpin(ids: readonly number[]): void {
    for (const id of ids) {
      const s = this.sent.get(id)
      if (s && s.users > 0) s.users--
    }
    this.trim()
  }

  /** Merges a region's groups; every model they name must be pinned (`ensure`). */
  merge(groups: MergeGroupJob[]): Promise<MergeResult> {
    if (this.closed) return Promise.reject(new Error('merge client closed'))
    for (const g of groups) for (const p of g.pieces) {
      if (!this.sent.has(p.model)) return Promise.reject(new Error(`merge: model ${p.model} was not sent`))
    }
    return new Promise<MergeResult>((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { groups, resolve, reject })
      this.post({ t: 'merge', id, groups })
    })
  }

  private post(msg: MergeRequest): void {
    if (this.worker) {
      try {
        this.worker.postMessage(msg)
        return
      } catch (err) {
        this.fail(`${err}`)
      }
    }
    // In-process: the same handler on a later task (a merge never runs inside the caller's job).
    if (msg.t === 'merge') setTimeout(() => this.runLocal(msg.id), 0)
    else this.local.handle(msg)
  }

  private runLocal(id: number): void {
    const p = this.pending.get(id)
    if (!p || this.closed) return
    const answer = this.local.handle({ t: 'merge', id, groups: p.groups })
    if (answer) this.answer(answer, true)
  }

  private answer(msg: MergeResponse, local = false): void {
    if ('ready' in msg || this.closed) return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.t === 'error') p.reject(new Error(msg.error))
    else {
      if (local) this.counts.local++
      else this.counts.worker++
      p.resolve(msg.result)
    }
  }

  /** Drops the least recently used models beyond the byte budget (none a merge in flight needs). */
  private trim(): void {
    if (this.sentBytes <= this.cacheBytes) return
    const drop: number[] = []
    for (const [id, s] of this.sent) {
      if (this.sentBytes <= this.cacheBytes) break
      if (s.users > 0) continue
      drop.push(id)
      this.sent.delete(id)
      this.geometries.delete(id)
      this.sentBytes -= s.bytes
    }
    if (drop.length) this.post({ t: 'drop', ids: drop })
  }

  /** The worker failed: every pending merge (and every later one) runs in-process. */
  private fail(why: string): void {
    if (!this.worker) return
    console.warn('[batch] merge worker failed; merging on the main thread:', why)
    try {
      this.worker.terminate()
    } catch {
      // already gone
    }
    this.worker = null
    // The in-process handler needs every model the worker had.
    for (const [id, g] of this.geometries) this.local.handle({ t: 'models', models: [{ id, primitives: primitivesOf(g) }] })
    for (const id of this.pending.keys()) setTimeout(() => this.runLocal(id), 0)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.worker?.terminate()
    } catch {
      // already gone
    }
    this.worker = null
    for (const p of this.pending.values()) p.reject(new Error('merge client closed'))
    this.pending.clear()
    this.sent.clear()
    this.geometries.clear()
    this.local.models.clear()
    this.sentBytes = 0
  }
}

/** A geometry export as the merge reads it (the arrays themselves: a worker gets a structured-clone copy). */
function primitivesOf(g: ModelGeometry): MergePrimitive[] {
  return g.primitives.map(p => ({
    positions: p.positions, normals: p.normals, uvs: p.uvs, uvs2: p.uvs2, indices: p.indices, mirrored: p.mirrored,
    // T12-M: a species' TEXCOORD_2 (flutter, crown AO) for `sroTreeW`; retail models have none.
    ...(p.uvs3 ? { uvs3: p.uvs3 } : {}),
  }))
}

/** The page's module worker for merges (null where workers cannot run, e.g. Node tests). */
export function createMergeWorker(): BatchWorkerLike | null {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./merge-worker.ts', import.meta.url), { type: 'module', name: 'sro-batch-merge' }) as unknown as BatchWorkerLike
  } catch (err) {
    console.warn('[batch] merge worker could not start:', err)
    return null
  }
}

// ---- group materials (table groups) ---------------------------------------------------------------------------

/** The table groups' own materials, one per key, shared by every region (never a converted material, §4.5). */
export class GroupMaterials {
  private readonly made = new Map<string, PBRMaterial>()

  constructor(readonly scene: Scene, readonly materials: ObjectMaterials, readonly tables: BatchTables) {}

  static keyOf(k: Readonly<GroupMaterialKey>): string {
    return `${k.cutout ? 'cutout' : 'opaque'}${k.sheen ? '+sheen' : ''}${k.lamp ? '+lamp' : ''}`
  }

  get count(): number {
    return this.made.size
  }

  /** The material of a key (made on first use). */
  get(k: Readonly<GroupMaterialKey>): PBRMaterial {
    const name = GroupMaterials.keyOf(k)
    let mat = this.made.get(name)
    if (mat) return mat
    mat = useWindowedLightFalloff(new PBRMaterial(`batch:${name}`, this.scene))
    // Two-sided pieces are emitted twice (merge-core.ts): the group draws single-sided.
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
    // The surface response per slot comes from the table (sroSurf, direct intensity, SSR, cut-off); the plugin's own
    // values only switch its defines: baked light on, puddles eligible (the slot's weight gates them), the lamp glow.
    const plugin = new SroSurfacePlugin(mat, this.materials.pbr.shared, { cls: k.sheen ? 'cloth' : 'stone', baked: true, selfLit: k.lamp })
    plugin.surf.w = 1
    if (k.sheen) this.materials.pbr.addExtras(mat, 'cloth')
    mat.metadata = { sroBatchGroup: name }
    this.tables.bindMaterial(mat, k)
    this.made.set(name, mat)
    return mat
  }

  dispose(): void {
    for (const m of this.made.values()) {
      this.materials.pbr.removeExtras(m)
      m.dispose(false, false)
    }
    this.made.clear()
  }
}

// ---- the region batch -----------------------------------------------------------------------------------------

/** How a region batch was made (the part's options). */
export interface RegionBatchOptions {
  /**
   * BT-A's material table: table groups where it takes a material. null (default): every piece in a material group
   * (the material mode: today's image, for the A/B and the tests).
   */
  tables?: BatchTables | null
  /** The merge worker (default: the host's, else a module worker; none: in-process). */
  worker?: BatchWorkerFactory | null
  /** Bytes of model geometry the worker keeps (default WORKER_CACHE_BYTES). */
  workerCacheBytes?: number
  /** Clock (ms) for the stats (default performance.now). */
  now?: () => number
  /** BT-T: how foliage is taken (trees.ts; default: merged with a table, refused without). */
  trees?: TreeOptions
  /**
   * Keep every group's CPU copy of its vertex arrays (default false: H-12 MM1 frees the tree groups' on a preset that
   * casts no foliage). Tests and tools that read the merged arrays back set it.
   */
  keepCpuCopies?: boolean
}

/** One claimed model of a region. */
interface Claim {
  model: WorldModel
  entry: CachedModel
  placements: readonly WorldPlacement[]
  /** BT-T: a foliage model, merged into the tree groups with its pivots. */
  tree: boolean
  /** T12-M: the model's swap when `entry` is its species (null: the retail model as itself). */
  swap: TreeSwap | null
}

/** What a group mesh is drawn with, and how it is culled. */
interface GroupMeta {
  key: string
  label: string
  material: Material
  orientation: number
  /** LOD group (range) and group-3 sub-chunk. */
  lod: 2 | 3
  table: boolean
  /** A cut-out or non-opaque group: a cut-out caster. */
  caster: boolean
  /** BT-T: merged trees (the pivot attribute, TREE_PIVOT_SIZE floats per vertex). */
  tree: boolean
  /** T12-M: a tree group holding a swapped species (TREE_PIVOT4_SIZE pivots, `sroTreeW`); set by the plan. */
  swapped?: boolean
  /** T12-M: a leaf tree group (a retail piece's synthesized flutter). */
  leaf?: boolean
}

interface LiveMesh {
  mesh: Mesh
  lod: 2 | 3
  cx: number
  cy: number
  cz: number
  radius: number
  /** The range spheres (centre xyz, radius) of the chunks it replaces; null: the mesh's own sphere. */
  spheres: Float32Array | null
}

/** A region's built batch (the object the listeners get). */
class BuiltBatch implements RegionBatch {
  alive = true
  readonly min: Vector3
  readonly max: Vector3
  /**
   * T12-M (WF15): the cut-out caster's vertex data from the merge worker (its table cut-out groups, LOD1 only), on a
   * preset that cast foliage when the region was built; null otherwise (render/shadows.ts copies on the main thread).
   */
  casterData: MergedCaster | null = null
  /**
   * H-12 MM3: the caster's merge jobs when the worker did not build the caster with the region (the region was far
   * from the focus, or the preset cast no foliage then): `requestCaster` has the worker build it on demand, so neither
   * the arrays of far regions stay on the heap nor a caster is ever copied on the main thread (WF15).
   */
  casterJobs: MergeGroupJob[] | null = null
  /** The model geometries the caster jobs name (pinned in the worker while a request runs). */
  casterModels: ModelGeometry[] = []
  casterPending = false

  constructor(
    private readonly part: RegionBatchPart,
    readonly owner: number,
    readonly region: number,
    readonly live: readonly LiveMesh[],
    readonly meshes: readonly AbstractMesh[],
    readonly shadowProxy: Mesh | null,
    readonly cutoutCasters: readonly AbstractMesh[],
    readonly slots: readonly BatchSlot[],
    readonly entries: readonly BatchTableEntry[],
    /** Material slots (negative ids): their converted material. */
    readonly materialSlots: ReadonlyMap<number, ObjectMaterial>,
    min: readonly number[],
    max: readonly number[],
    readonly triangles: number,
    readonly vertices: number,
    readonly bytes: number,
  ) {
    this.min = new Vector3(min[0], min[1], min[2])
    this.max = new Vector3(max[0], max[1], max[2])
  }

  setEmissive(slot: number, r: number, g: number, b: number): void {
    if (!this.alive) return
    this.part.writeEmissive(this, slot, r, g, b)
  }

  /**
   * H-12 MM3 (render/shadows.ts): asks the worker for the cut-out caster's arrays. True while they are coming (the
   * caller tries again later); false when the batch has no caster jobs (the caller copies on the main thread).
   */
  requestCaster(): boolean {
    if (!this.alive || !this.casterJobs?.length) return false
    if (this.casterData) return false
    if (!this.casterPending) this.part.requestCaster(this)
    return this.casterPending
  }
}

interface Build {
  cancelled: boolean
  resolve: (b: RegionBatch | null) => void
  /** Meshes made so far (disposed if the build is dropped). */
  meshes: Mesh[]
  proxy: Mesh | null
  entries: BatchTableEntry[]
  /** Model ids pinned in the merge client (released once the merge settled, or when the build is dropped first). */
  pinned: number[]
  /** The merge is posted: its settling releases the pins. */
  merging: boolean
}

interface RegionState {
  owner: number
  claims: Claim[]
  build: Build | null
  batch: BuiltBatch | null
}

/** The mutable counters behind `stats`. */
interface BatchCounters {
  regions: number
  meshes: number
  groups: number
  tableGroups: number
  materialGroups: number
  slots: number
  triangles: number
  vertices: number
  bytes: number
  proxies: number
  pending: number
  builds: number
  dropped: number
  claims: number
  refused: number
  /** Merge time in the worker, summed over builds (ms). */
  workerMs: number
  /** The longest single merge (ms): BATCHING §5's worker budget is ≤ 15 ms per region. */
  workerMaxMs: number
  /** Main-thread time in the batch's stream jobs, summed (ms). */
  mainMs: number
  /** The longest single main-thread job (ms): it must fit the stream's frame budget. */
  mainMaxMs: number
  /** The longest job per phase (ms): a model's geometry export and copy, the plan, one group mesh. */
  exportMaxMs: number
  planMaxMs: number
  meshMaxMs: number
  /** Main-thread jobs over SLOW_JOB_MS. */
  slowJobs: number
  worker: number
  cachedModels: number
  groupMaterials: number
  /** W11-S: group meshes carrying cloth pivots (SRO_CLOTH_WIND). */
  clothGroups: number
  /** H-12 MM3: cut-out casters the worker built on demand. */
  casterRequests: number
}

/**
 * The batching part (World.batch): BT-M's RegionBatcher. Made by batch/index.ts `createBatchPart` on the PBR path of a
 * streamed world; tests and the lab make it directly (`new RegionBatchPart(host, { tables })`).
 */
export class RegionBatchPart implements BatchPart {
  private readonly regions = new Map<number, RegionState>()
  private readonly client: MergeClient
  private readonly tables: BatchTables | null
  private readonly groupMaterials: GroupMaterials | null
  /** BT-T: the static variants, the tree groups' materials and the instancing fallback (trees.ts). */
  readonly trees: TreeBatch
  private readonly proxyMaterial: StandardMaterial
  private readonly counters: BatchCounters
  private readonly now: () => number
  private readonly lastCam = new Vector3(NaN, NaN, NaN)
  private rangeScale = 1
  private visible = true
  /** False: no draw ranges (WorldObjects.setLod(false), the viewer's LOD toggle). */
  private ranges = true
  private disposed = false
  private nextMaterialSlot = -1
  /** The slowest main-thread jobs (the lab panel, the bench): ms and what ran. */
  readonly slowest: Array<{ ms: number; what: string }> = []
  private readonly tmp = new Matrix()

  /** H-12 MM1: every group keeps its CPU copy (RegionBatchOptions.keepCpuCopies). */
  private readonly keepCpu: boolean

  constructor(readonly host: BatchHost, opts: RegionBatchOptions = {}) {
    this.keepCpu = !!opts.keepCpuCopies
    this.tables = opts.tables ?? null
    this.now = opts.now ?? (() => performance.now())
    const factory = opts.worker !== undefined ? opts.worker : host.worker ?? createMergeWorker
    this.client = new MergeClient(factory, opts.workerCacheBytes ?? WORKER_CACHE_BYTES)
    this.groupMaterials = this.tables ? new GroupMaterials(host.scene, host.materials, this.tables) : null
    this.trees = new TreeBatch(host, this.tables, opts.trees)
    this.proxyMaterial = new StandardMaterial('batchShadowProxy', host.scene)
    this.proxyMaterial.backFaceCulling = false
    this.proxyMaterial.disableLighting = true
    this.counters = {
      regions: 0, meshes: 0, groups: 0, tableGroups: 0, materialGroups: 0, slots: 0, triangles: 0, vertices: 0, bytes: 0, proxies: 0,
      pending: 0, builds: 0, dropped: 0, claims: 0, refused: 0, workerMs: 0, workerMaxMs: 0, mainMs: 0, mainMaxMs: 0, exportMaxMs: 0, planMaxMs: 0, meshMaxMs: 0, slowJobs: 0, worker: this.client.usesWorker ? 1 : 0, cachedModels: 0, casterRequests: 0,
      groupMaterials: 0, clothGroups: 0,
    }
  }

  get stats(): Readonly<Record<string, number>> {
    this.counters.worker = this.client.usesWorker ? 1 : 0
    this.counters.cachedModels = this.client.cachedModels
    this.counters.groupMaterials = this.groupMaterials?.count ?? 0
    // BT-T's counters join the live object (the lab panel may keep it).
    Object.assign(this.counters, this.trees.stats)
    return this.counters as unknown as Record<string, number>
  }

  /** The table mode is on (BT-A's table given). */
  get tableMode(): boolean {
    return this.tables !== null
  }

  // ---- the claim --------------------------------------------------------------------------------------------------

  /**
   * DRAGON-INT: a remastered retail model loads its variant (remaster.ts; the PBR path only, Low never batches); else
   * BT-T: a skinned foliage model loads its static variant (trees.ts; none without a table).
   */
  modelFor(model: WorldModel): WorldModel {
    if (this.disposed) return model
    return remasterVariantOf(model, this.host.models) ?? this.trees.modelFor(model)
  }

  claim(owner: number, source: BatchModelSource, placements: readonly WorldPlacement[]): readonly WorldPlacement[] {
    if (this.disposed || !placements.length) return []
    const entry = source.entry
    if (!entry || !entry.prep || !entry.prep.geometry.length) return this.refuse()
    const geometry = entry.prep.geometry
    // Every primitive must be one of ours (a batch record): its class decides its group at commit.
    for (const m of geometry) if (!this.host.materials.batchRecord(m.material)) return this.refuse()
    // BT-T: foliage goes to the tree groups (or the instancing fallback, which takes it here); refused when off. T12-M:
    // a swapped model (loaded as its species) is always a tree claim (WF12: cj_ricestraw, the Tarim weed).
    const s = this.trees.swapOf(source.model)
    const swap = s && entry.model.index === s.species.index ? s : null
    const tree = isFoliage(source.model, geometry) || swap !== null
    if (tree) {
      const how = this.trees.claim(owner, source, placements)
      if (!how) return this.refuse()
      if (how === 'instance') {
        this.counters.claims++
        return placements
      }
    }
    let st = this.regions.get(owner)
    if (!st) {
      st = { owner, claims: [], build: null, batch: null }
      this.regions.set(owner, st)
    }
    st.claims.push({ model: source.model, entry, placements, tree, swap })
    this.counters.claims++
    return placements
  }

  /** Counts one main-thread job that started at `t0`. */
  private jobTime(t0: number, phase: 'exportMaxMs' | 'planMaxMs' | 'meshMaxMs', what = ''): void {
    const ms = this.now() - t0
    const c = this.counters
    c.mainMs += ms
    if (ms > c.mainMaxMs) c.mainMaxMs = ms
    if (ms > c[phase]) c[phase] = ms
    if (ms > SLOW_JOB_MS) {
      c.slowJobs++
      this.slowest.push({ ms: Math.round(ms * 10) / 10, what: `${phase.slice(0, -5)} ${what}` })
      this.slowest.sort((a, b) => b.ms - a.ms)
      if (this.slowest.length > 8) this.slowest.length = 8
    }
  }

  private refuse(): readonly WorldPlacement[] {
    this.counters.refused++
    return []
  }

  // ---- the build --------------------------------------------------------------------------------------------------

  commit(region: BatchRegion, ctx: BatchCommitContext): Promise<RegionBatch | null> | RegionBatch | null {
    const st = this.regions.get(region.owner)
    if (this.disposed || !st || !st.claims.length || st.build || st.batch) return null
    return new Promise<RegionBatch | null>(resolve => {
      const build: Build = { cancelled: false, resolve, meshes: [], proxy: null, entries: [], pinned: [], merging: false }
      st.build = build
      this.counters.pending++
      const done = (batch: BuiltBatch | null) => {
        if (st.build !== build) return
        st.build = null
        this.counters.pending--
        if (batch) {
          st.batch = batch
          this.count(batch, 1)
        }
        resolve(batch)
      }
      const fail = (why: string, err: unknown) => {
        console.warn(`[batch] region ${why} failed`, err)
        this.dropBuild(build)
        done(null)
      }
      // 1. Each model's geometry export (made once per cached model) and its copy to the worker: one job each.
      const claims = [...st.claims]
      const ids = new Map<Claim, number>()
      let i = 0
      const next = (): void => {
        if (build.cancelled) return
        if (i < claims.length) {
          const c = claims[i++]!
          ctx.schedule(() => {
            if (build.cancelled) return
            const t0 = this.now()
            try {
              const g = geometryOf(c.entry)
              if (g && g.primitives.length) {
                const id = this.client.ensure(g)
                build.pinned.push(id)
                ids.set(c, id)
              }
            } catch (err) {
              fail('geometry export', err)
              return
            }
            this.jobTime(t0, 'exportMaxMs', `${c.model.source} ${c.entry.geometry?.vertices ?? 0} v`)
            next()
          })
          return
        }
        // 2. The pieces (matrices, slots, groups), then the worker merge. T12-M: once the claims' crown tints are in.
        const tints = this.tintsPending(claims)
        if (tints) {
          tints.then(() => {
            if (!build.cancelled) planJob()
          })
        } else planJob()
      }
      const planJob = (): void => ctx.schedule(() => {
        if (build.cancelled) return
        const t0 = this.now()
        let plan: RegionPlan
        try {
          plan = this.plan(region, claims, ids, build)
        } catch (err) {
          fail('plan', err)
          return
        }
        this.jobTime(t0, 'planMaxMs')
        if (!plan.jobs.length) {
          this.dropBuild(build)
          done(null)
          return
        }
        build.merging = true
        const settle = () => {
          this.client.unpin(build.pinned)
          build.pinned = []
        }
        this.client.merge(plan.jobs).then(result => {
          settle()
          if (build.cancelled || this.disposed) return
          this.counters.workerMs += result.ms
          this.counters.workerMaxMs = Math.max(this.counters.workerMaxMs, result.ms)
          if (!result.groups.length) {
            // Nothing with a triangle: no batch (the placements drew nothing as chunks either).
            this.dropBuild(build)
            done(null)
            return
          }
          this.place(region, ctx, build, plan, result, done)
        }, err => {
          settle()
          if (!build.cancelled) fail('merge', err)
        })
      })
      next()
    })
  }

  /** T12-M: the crown tints a region's swapped claims still wait for (null: none). Never rejects. */
  private tintsPending(claims: readonly Claim[]): Promise<unknown> | null {
    const tints = this.trees.tints
    if (!tints) return null
    const waits: Promise<void>[] = []
    for (const c of claims) {
      const p = c.swap && c.swap.tint > 0 ? tints.pending(c.swap.species) : null
      if (p) waits.push(p)
    }
    return waits.length ? Promise.all(waits) : null
  }

  /** T12-M (WF15): the preset casts foliage (`shadows.foliageM` > 0: High+), so the worker builds the cut-out caster. */
  private foliageCasts(): boolean {
    return this.foliageM() > 0
  }

  private foliageM(): number {
    const q = (this.host.world as { render?: { quality?: { shadows?: { foliageM?: number } } } | null } | null | undefined)?.render?.quality
    return q?.shadows?.foliageM ?? 0
  }

  /**
   * H-12 MM3: the worker builds a region's caster arrays only when the region is within the caster drop range of the
   * stream's focus (render/shadows.ts builds casters within foliageM + CASTER_BUILD_MARGIN_M and drops them past
   * foliageM + CASTER_DROP_MARGIN_M); a farther region is copied on the main thread if the camera ever gets near.
   * Without a stream focus, every region (as before).
   */
  private casterNear(region: BatchRegion): boolean {
    const REGION_M = 192
    const f = (this.host.world as { stream?: { focusPoint?: { x: number; z: number } } | null } | null | undefined)?.stream?.focusPoint
    if (!f || !(f.x === f.x)) return true
    const x0 = region.origin[0], z1 = region.origin[2]
    const d = Math.hypot(Math.max(x0 - f.x, 0, f.x - x0 - REGION_M), Math.max(z1 - REGION_M - f.z, 0, f.z - z1))
    return d <= this.foliageM() + CASTER_DROP_MARGIN_M
  }

  /** The groups and pieces of a region (main thread: placement matrices, table slots, group materials). */
  private plan(region: BatchRegion, claims: readonly Claim[], ids: ReadonlyMap<Claim, number>, build: Build): RegionPlan {
    const scene = this.host.scene
    const fallback = defaultOrientation(scene)
    const groups = new Map<string, { meta: GroupMeta; pieces: MergePiece[] }>()
    const slots: BatchSlot[] = []
    const slotOf = new Map<ObjectMaterial, number>()
    const materialSlots = new Map<number, ObjectMaterial>()
    const entryOf = new Map<MaterialBatchRecord, BatchTableEntry | null>()
    const tables = this.tables
    // RP-1 / RP-2: each group's range spheres, one per (model, cell) it holds (the chunks it replaces).
    const ranges = new Map<string, number[]>()
    const rangeSeen = new Set<string>()
    // T12-M: T12-N's band slots (null without a trees part: every swapped tree then draws its LOD1 only).
    const bandSlots = this.trees.slots()
    let unslotted = 0
    // H-12 TD-1: swapped placements whose pieces the table refused (a material group: their LOD1 is never banded)
    const unbanded = new Set<number>()
    const acquire = (record: MaterialBatchRecord): BatchTableEntry | null => {
      if (entryOf.has(record)) return entryOf.get(record)!
      let entry: BatchTableEntry | null = null
      try {
        entry = tables!.acquire(record)
      } catch (err) {
        console.warn('[batch] table slot refused', record.name, err)
        entry = null
      }
      entryOf.set(record, entry)
      if (entry) build.entries.push(entry)
      return entry
    }
    for (const c of claims) {
      const id = ids.get(c)
      const g = geometryOf(c.entry)
      if (id === undefined || !g) continue
      const swap = c.swap
      // Placements by (LOD group, sub-chunk): group 3 keeps today's 96 m sub-chunks (its range is exactly today's).
      const cells = new Map<string, { lod: 2 | 3; list: WorldPlacement[] }>()
      for (const p of c.placements) {
        const lod: 2 | 3 = p.group === 3 ? 3 : 2
        let cell = '0'
        if (lod === 3) {
          const sx = Math.min(1, Math.max(0, Math.floor((p.position[0] - region.origin[0]) / G3_CELL_M)))
          const sz = Math.min(1, Math.max(0, Math.floor((region.origin[2] - p.position[2]) / G3_CELL_M)))
          cell = `${sz * 2 + sx}`
        }
        const k = `${lod}|${cell}`
        const e = cells.get(k)
        if (e) e.list.push(p)
        else cells.set(k, { lod, list: [p] })
      }
      const matrices = new Map<string, Float32Array>()
      for (const [k, cell] of cells) {
        const m = new Float32Array(cell.list.length * 16)
        cell.list.forEach((p, n) => placementMatrixTo(p, m, n * 16, this.tmp))
        // T12-M: the species in the retail envelope, its trunk base on the retail one (TREES §W3.2, WF20).
        if (swap) for (let n = 0; n < cell.list.length; n++) foldSwap(m, n * 16, swap.fit, c.model.treeSwap?.offset)
        matrices.set(k, m)
      }
      const local = modelBounds(g)
      const spheres = new Map([...matrices].map(([k, m]) => [k, chunkSphere(local, m)] as const))
      // BT-T: each tree's root, written to every vertex of its instance (the foliage plugin's SRO_FOL_PIVOT). T12-M: a
      // swapped tree's root is its folded matrix's translation (`tierPiece` below).
      const pivots = c.tree && !swap ? new Map([...cells].map(([k, cell]) => [k, treePivots(cell.list)] as const)) : null
      // T12-M: each swapped tree's band slot, per cell; per (cell, tier) its piece's matrices and 4-float pivots.
      const treeSlots = swap ? new Map([...cells].map(([k, cell]) => [k, Int32Array.from(cell.list, p => bandSlotOf(bandSlots, p))] as const)) : null
      if (treeSlots) for (const s of treeSlots.values()) for (const v of s) if (v < 0) unslotted++
      const tierPieces = new Map<string, { matrices: Float32Array; pivots: Float32Array } | null>()
      const tierPiece = (k: string, tier: number): { matrices: Float32Array; pivots: Float32Array } | null => {
        const key = `${k}|${tier}`
        let out = tierPieces.get(key)
        if (out !== undefined) return out
        const m = matrices.get(k)!
        const s = treeSlots!.get(k)!
        if (tier === 2 && s.some(v => v < 0)) {
          // Only a tree with a slot draws its LOD2 (one without draws its LOD1 at every distance: never twice).
          const keep: number[] = []
          s.forEach((v, i) => {
            if (v >= 0) keep.push(i)
          })
          if (!keep.length) out = null
          else {
            const fm = new Float32Array(keep.length * 16)
            const fs = new Int32Array(keep.length)
            keep.forEach((i, j) => {
              fm.set(m.subarray(i * 16, i * 16 + 16), j * 16)
              fs[j] = s[i]!
            })
            out = { matrices: fm, pivots: swapPivots(fm, fs, 2) }
          }
        } else out = { matrices: m, pivots: swapPivots(m, s, tier) }
        tierPieces.set(key, out)
        return out
      }
      g.primitives.forEach((prim, pi) => {
        const base = this.host.materials.batchRecord(prim.material as ObjectMaterial | null)
        if (!prim.material || !base) return
        // T12-M: a tinted retail model's species sprite takes its tint's record (TreeTints; a slot of its own).
        let record = swap && swap.tint > 0 && this.trees.tints ? this.trees.tints.recordFor(swap.species, base, swap.tint) : base
        // T12-M: the piece's tier (a swapped species' far tiers; 0: not banded).
        const tier = swap && (prim.tier === 1 || prim.tier === 2) ? prim.tier : 0
        // BT-T: a tree is never a lamp (a leaf material whose name says 'light' must not take the lamp path).
        const cls = c.tree && classOf(record) === 'lamp' ? 'merge' : classOf(record)
        // The table takes merge-class materials, and NL's lamps when it has a lamp group. A retail emissive (the
        // luxury-house tiger) keeps its converted material, whose self-light PbrSurfaces sets from the ambient every
        // frame (its base colour is not in the record; one draw at the plaza).
        const takes = !!tables && (cls === 'merge' || (cls === 'lamp' && tables.lamps && !record.emissive))
        let entry = takes ? acquire(record) : null
        if (!entry && record !== base) {
          // A tint the table refused draws the species' own sprite.
          record = base
          entry = takes ? acquire(base) : null
        }
        const mat = record.material
        // The slot NL maps its lamp rows onto (one per material of the region).
        let slot = slotOf.get(mat)
        if (slot === undefined) {
          slot = entry ? entry.slot : this.nextMaterialSlot--
          if (!entry) materialSlots.set(slot, mat)
          slotOf.set(mat, slot)
          slots.push({ slot, model: c.model, material: mat, record, cls })
        }
        const orient = effectiveOrientation(mat, prim.sideOrientation, fallback)
        for (const [k, cell] of cells) {
          // T12-M: a swapped piece in a table group is banded; in a material group (no band) only its LOD1 draws.
          const tp = swap && entry ? tierPiece(k, tier) : null
          if (swap && !entry) for (const p of cell.list) unbanded.add(placementKey(p.region, p.uid))
          if (swap && (entry ? !tp : tier === 2)) continue
          const target = entry
            ? (c.tree ? `t:${treeKeyName(treeKeyOf(record))}` : `t:${GroupMaterials.keyOf(tableKey(record, cls))}`)
            : (c.tree ? `m:${mat.uniqueId}:tree` : `m:${mat.uniqueId}`)
          const gk = `${k}|${target}`
          let grp = groups.get(gk)
          if (!grp) {
            const meta: GroupMeta = entry
              ? (c.tree ? this.treeMeta(gk, cell.lod, treeKeyOf(record), orient) : this.tableMeta(gk, cell.lod, tableKey(record, cls), orient))
              // UV scroll: a scrolling cut-out casts nothing (the shadow pass would alpha-test a still mask).
              : { key: gk, label: `${cell.lod}:${mat.name}`, material: mat, orientation: orient, lod: cell.lod, table: false, caster: !isOpaqueMaterial(mat) && !record.uvScroll, tree: c.tree }
            grp = { meta, pieces: [] }
            groups.set(gk, grp)
          }
          const sk = `${gk}|${id}|${k}`
          if (!rangeSeen.has(sk)) {
            rangeSeen.add(sk)
            let list = ranges.get(gk)
            if (!list) ranges.set(gk, (list = []))
            list.push(...spheres.get(k)!)
          }
          // W11-S: a cloth piece in a table group carries its per-piece cloth pivots (none without a cloth record).
          const cloth = entry && !c.tree && record.cloth ? clothPivots(primitiveBounds(prim.positions), matrices.get(k)!, record.cloth, scalesOf(cell.list)) : null
          const pieceMatrices = tp ? tp.matrices : matrices.get(k)!
          grp.pieces.push({
            model: id,
            primitive: pi,
            matrices: pieceMatrices,
            pivots: tp ? tp.pivots : swap ? rootPivots(pieceMatrices) : pivots?.get(k) ?? cloth,
            twoSided: !!entry && record.twoSided,
            flip: orient !== grp.meta.orientation,
            uv2: entry ? { slot: entry.slot, layer: entry.layer, scale: entry.scale, offsetU: entry.offsetU, offsetV: entry.offsetV } : null,
            ...(swap ? { tier, wind: true } : {}),
          })
          if (tp) grp.meta.swapped = true
        }
      })
    }
    if (unslotted) this.trees.noteUnslotted(unslotted)
    this.trees.noteUnbanded(region.owner, [...unbanded])
    const workerCasters = this.foliageCasts() && this.casterNear(region)
    const metas: GroupMeta[] = []
    const jobs: MergeGroupJob[] = []
    const casterJobs: MergeGroupJob[] = []
    for (const { meta, pieces } of groups.values()) {
      metas.push(meta)
      // The shadow proxy: opaque LOD-group-2 pieces (BATCHING §3.9; group 3 stays out, as in ShadowProxies below Ultra).
      // W11-S: a table group holding a cloth piece carries the 4-float cloth pivot (the others' stay 0: no sway).
      let pivotSize: 0 | 3 | 4 = meta.tree ? TREE_PIVOT_SIZE : meta.table && pieces.some(p => p.pivots) ? CLOTH_PIVOT_SIZE : 0
      // T12-M: a tree group holding a swapped species: the 4-float tree pivot (a retail tree's widened, tier 0) and
      // `sroTreeW`.
      const swapped = meta.tree && !!meta.swapped
      if (swapped) {
        pivotSize = TREE_PIVOT4_SIZE
        for (const p of pieces) {
          if (p.pivots && p.pivots.length === Math.floor(p.matrices.length / 16) * TREE_PIVOT_SIZE) p.pivots = widenPivots(p.pivots)
        }
      }
      jobs.push({
        key: meta.key,
        pieces,
        pivotSize,
        proxy: meta.lod === 2 && !meta.caster,
        ...(swapped ? { treeW: true, leaf: !!meta.leaf } : {}),
        // T12-M (WF15): the worker copies the table cut-out groups (LOD1 of the trees) into the caster on High+.
        ...(workerCasters && meta.table && meta.caster ? { caster: { lod: meta.lod } } : {}),
      })
      // H-12 MM3: otherwise the caster's jobs are kept for an on-demand worker request (BuiltBatch.requestCaster)
      if (!workerCasters && meta.table && meta.caster) casterJobs.push({ ...jobs[jobs.length - 1]!, caster: { lod: meta.lod } })
    }
    const casterModels = casterJobs.length ? claims.filter(c => ids.has(c)).map(c => geometryOf(c.entry)).filter((g): g is ModelGeometry => !!g) : []
    return { jobs, metas, slots, materialSlots, ranges: new Map([...ranges].map(([k, l]) => [k, new Float32Array(l)] as const)), casterJobs, casterModels }
  }

  private tableMeta(key: string, lod: 2 | 3, k: GroupMaterialKey, orientation: number): GroupMeta {
    const material = this.groupMaterials!.get(k)
    return { key, label: `${lod}:${GroupMaterials.keyOf(k)}`, material, orientation, lod, table: true, caster: k.cutout, tree: false }
  }

  /**
   * BT-T: a tree group (its own table material with the foliage plugin, trees.ts). Every tree group, wood included, is
   * a caster (X2): trees cast whole within the foliage range only, as the unbatched foliage did, never in the proxy.
   */
  private treeMeta(key: string, lod: 2 | 3, k: TreeKey, orientation: number): GroupMeta {
    const material = this.trees.material(k)
    return { key, label: `${lod}:${treeKeyName(k)}`, material, orientation, lod, table: true, caster: true, tree: true, leaf: k.leaf }
  }

  /** Creates the region's meshes from a merge, one budgeted job per group, then the proxy, then shows the batch. */
  private place(region: BatchRegion, ctx: BatchCommitContext, build: Build, plan: RegionPlan, result: MergeResult, done: (b: BuiltBatch | null) => void): void {
    const scene = this.host.scene
    const byKey = new Map(plan.metas.map(m => [m.key, m] as const))
    const live: LiveMesh[] = []
    const casters: AbstractMesh[] = []
    let bytes = 0
    let gi = 0
    const step = (): void => {
      if (build.cancelled) return
      if (!ctx.alive()) {
        // The region went; removeRegion follows (and resolves the build).
        return
      }
      const t0 = this.now()
      if (gi < result.groups.length) {
        const g = result.groups[gi++]!
        const meta = byKey.get(g.key)
        if (meta) {
          const mesh = this.groupMesh(scene, region.owner, g, meta)
          // H-12 MM1: on a preset that casts no foliage nothing reads a tree group's arrays back (render/shadows.ts
          // copies cut-out groups only on High+): the CPU copy goes (an Apple GPU's unified memory paid it twice)
          if (meta.tree && !this.keepCpu && !this.foliageCasts()) mesh.geometry?.clearCachedData()
          build.meshes.push(mesh)
          const cx = (g.min[0] + g.max[0]) / 2, cy = (g.min[1] + g.max[1]) / 2, cz = (g.min[2] + g.max[2]) / 2
          const radius = Math.hypot(g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]) / 2
          live.push({ mesh, lod: meta.lod, cx, cy, cz, radius, spheres: plan.ranges.get(g.key) ?? null })
          if (meta.caster) casters.push(mesh)
          bytes += g.positions.byteLength + g.normals.byteLength + (g.uvs?.byteLength ?? 0) + (g.uvs2?.byteLength ?? 0) + (g.pivots?.byteLength ?? 0) + (g.treeW?.byteLength ?? 0) + g.indices.byteLength
        }
        this.jobTime(t0, 'meshMaxMs', `${g.key} ${g.vertices} v`)
        ctx.schedule(step)
        return
      }
      if (result.proxy) {
        build.proxy = this.proxyMesh(scene, region, result.proxy.positions, result.proxy.indices)
        bytes += result.proxy.positions.byteLength + result.proxy.indices.byteLength
      }
      this.jobTime(t0, 'meshMaxMs')
      const finish = () => {
        if (build.cancelled || this.disposed) return
        const min = [Infinity, Infinity, Infinity]
        const max = [-Infinity, -Infinity, -Infinity]
        for (const g of result.groups) for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a]!, g.min[a]!)
          max[a] = Math.max(max[a]!, g.max[a]!)
        }
        const batch = new BuiltBatch(
          this, region.owner, region.id, live, live.map(l => l.mesh), build.proxy, casters, plan.slots, build.entries, plan.materialSlots,
          min, max, result.triangles, result.vertices, bytes,
        )
        // T12-M (WF15): the worker's cut-out caster (High+), for render/shadows.ts to upload as it is.
        batch.casterData = result.caster ?? null
        batch.casterJobs = plan.casterJobs.length ? plan.casterJobs : null
        batch.casterModels = plan.casterModels
        build.meshes = []
        build.proxy = null
        build.entries = []
        for (const l of live) this.apply(l, this.camOrZero())
        done(batch)
      }
      const ready = build.entries.length ? this.tables?.ready?.(build.entries) : undefined
      if (ready && typeof (ready as Promise<void>).then === 'function') {
        ;(ready as Promise<void>).then(finish, err => {
          console.warn('[batch] table cells failed; the batch shows anyway', err)
          finish()
        })
      } else finish()
    }
    ctx.schedule(step)
  }

  private groupMesh(scene: Scene, owner: number, g: MergedGroup, meta: GroupMeta): Mesh {
    const mesh = new Mesh(`batch:${owner}:${meta.label}`, scene)
    mesh.setVerticesData(VertexBuffer.PositionKind, g.positions, false, 3)
    mesh.setVerticesData(VertexBuffer.NormalKind, g.normals, false, 3)
    if (g.uvs) mesh.setVerticesData(VertexBuffer.UVKind, g.uvs, false, 2)
    if (g.uvs2) mesh.setVerticesData(VertexBuffer.UV2Kind, g.uvs2, false, 2)
    if (g.pivots && g.pivotSize) mesh.setVerticesData(BATCH_PIVOT_KIND, g.pivots, false, g.pivotSize)
    // T12-M (TREES §W3.4, WF5): the merged tree wind data, 4 bytes per vertex (unorm8x4: a vec4 in the shader).
    if (g.treeW) {
      const buffer = new VertexBuffer(scene.getEngine(), g.treeW, FOLIAGE_TREEW_KIND, { updatable: false, size: 4, stride: 4, type: VertexBuffer.UNSIGNED_BYTE, normalized: true })
      mesh.setVerticesBuffer(buffer)
    }
    // W11-S: a cloth group's material takes the foliage plugin's cloth slot (once; the material is shared per key).
    if (g.pivots && g.pivotSize === CLOTH_PIVOT_SIZE && meta.table && !meta.tree) {
      this.enableCloth(meta.material)
      this.counters.clothGroups++
    }
    mesh.setIndices(g.indices, g.vertices)
    // The material first: assigning one to a mesh whose orientation hint is set nulls the material's sideOrientation
    // (Babylon's Mesh.material setter), and a converted material must never change (§4.5).
    mesh.material = meta.material
    mesh.sideOrientation = meta.orientation
    mesh.isPickable = false
    mesh.metadata = meta.tree
      ? { sroWorld: 'object', sroBatch: meta.table ? 'table' : 'material', sroTree: true }
      : { sroWorld: 'object', sroBatch: meta.table ? 'table' : 'material' }
    // T12-M: a tree group with tier-2 pieces casts its LOD1 prefix only (render/shadows.ts `mergeCutoutCasters`).
    if (g.casterVertices !== undefined && g.casterIndices !== undefined) {
      ;(mesh.metadata as { sroCasterPrefix?: CasterPrefix }).sroCasterPrefix = { vertices: g.casterVertices, indices: g.casterIndices }
    }
    mesh.layerMask |= WORLD_OBJECT_LAYER
    mesh.freezeWorldMatrix()
    mesh.doNotSyncBoundingInfo = true
    // Hidden until the whole region is in (its range test runs then).
    mesh.setEnabled(false)
    this.counters.groups++
    if (meta.table) this.counters.tableGroups++
    else this.counters.materialGroups++
    return mesh
  }

  /**
   * W11-S: puts the foliage plugin's cloth slot (SRO_CLOTH_WIND, TL-M's chunk) on a `+sheen` group material: the
   * weather's wind, the minimum breeze, never the CSM wrapper (the proxy casts the cloth still, TOWN_LIFE §5.1).
   */
  private enableCloth(material: Material): void {
    const foliage = (this.host.world as { foliage?: PbrFoliage } | null | undefined)?.foliage ?? null
    foliage?.attach(material, { leaf: false, kind: 'static', cloth: true, breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
  }

  private proxyMesh(scene: Scene, region: BatchRegion, positions: Float32Array, indices: Uint32Array): Mesh {
    const mesh = new Mesh(`batchProxy:${region.owner}`, scene)
    mesh.setVerticesData(VertexBuffer.PositionKind, positions, false, 3)
    mesh.setIndices(indices, positions.length / 3)
    mesh.layerMask = SHADOW_PROXY_LAYER
    mesh.isPickable = false
    mesh.receiveShadows = false
    mesh.material = this.proxyMaterial
    mesh.metadata = { sroWorld: 'shadowProxy', sroBatch: 'proxy' }
    mesh.freezeWorldMatrix()
    mesh.doNotSyncBoundingInfo = true
    this.counters.proxies++
    return mesh
  }

  /** Disposes what a dropped build made and gives back its slots and pins. */
  private dropBuild(build: Build): void {
    build.cancelled = true
    if (!build.merging && build.pinned.length) {
      this.client.unpin(build.pinned)
      build.pinned = []
    }
    for (const m of build.meshes) this.disposeGroupMesh(m)
    build.meshes = []
    if (build.proxy) {
      build.proxy.dispose(false, false)
      this.counters.proxies--
      build.proxy = null
    }
    for (const e of build.entries) this.releaseEntry(e)
    build.entries = []
    this.counters.dropped++
  }

  private disposeGroupMesh(m: Mesh): void {
    const md = m.metadata as { sroBatch?: string; sroTree?: boolean } | null
    const table = md?.sroBatch === 'table'
    // T12-M (WF8): a tree group's 4-float pivot is a tree pivot, never a cloth one.
    const cloth = table && !md?.sroTree && m.getVertexBuffer(BATCH_PIVOT_KIND)?.getSize() === CLOTH_PIVOT_SIZE
    m.dispose(false, false)
    this.counters.groups--
    if (table) this.counters.tableGroups--
    else this.counters.materialGroups--
    if (cloth) this.counters.clothGroups--
  }

  private releaseEntry(e: BatchTableEntry): void {
    try {
      this.tables?.release(e)
    } catch (err) {
      console.warn('[batch] table release failed', err)
    }
  }

  private count(b: BuiltBatch, sign: 1 | -1): void {
    const c = this.counters
    c.regions += sign
    c.meshes += sign * b.meshes.length
    c.slots += sign * b.entries.length
    c.triangles += sign * b.triangles
    c.vertices += sign * b.vertices
    c.bytes += sign * b.bytes
    if (sign > 0) c.builds++
  }

  // ---- NL's lamp slots ------------------------------------------------------------------------------------------

  /** A batch's `setEmissive`: a table slot's texel 5, or a material group's converted material (as NL did per mesh). */
  writeEmissive(batch: BuiltBatch, slot: number, r: number, g: number, b: number): void {
    if (this.disposed) return
    if (slot >= 0) {
      this.tables?.setEmissive(slot, r, g, b)
      return
    }
    const mat = batch.materialSlots.get(slot)
    if (mat) mat.emissiveColor.set(r, g, b)
  }

  // ---- unload and lifetime ----------------------------------------------------------------------------------------

  removeRegion(owner: number): void {
    this.trees.removeRegion(owner)
    const st = this.regions.get(owner)
    if (!st) return
    this.regions.delete(owner)
    const build = st.build
    if (build) {
      st.build = null
      this.dropBuild(build)
      this.counters.pending--
      build.resolve(null)
    }
    const b = st.batch
    if (b) {
      st.batch = null
      this.disposeBatch(b)
    }
  }

  private disposeBatch(b: BuiltBatch): void {
    b.alive = false
    this.count(b, -1)
    for (const m of b.meshes) this.disposeGroupMesh(m as Mesh)
    if (b.shadowProxy) {
      b.shadowProxy.dispose(false, false)
      this.counters.proxies--
    }
    for (const e of b.entries) this.releaseEntry(e)
  }

  setRangeScale(scale: number): void {
    const s = Math.max(0.1, Number.isFinite(scale) ? scale : 1)
    if (s === this.rangeScale) return
    this.rangeScale = s
    this.trees.setRangeScale(s)
    this.refresh()
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return
    this.visible = on
    this.trees.setVisible(on)
    this.refresh()
  }

  setLod(on: boolean): void {
    if (on === this.ranges) return
    this.ranges = on
    this.trees.setRanges(on)
    this.refresh()
  }

  update(cam: Vector3, _force?: boolean): void {
    this.lastCam.copyFrom(cam)
    this.applyAll(cam)
  }

  /**
   * H-12 MM3: the worker builds a batch's cut-out caster arrays on demand (its kept caster jobs; the models pinned
   * while it runs). render/shadows.ts uploads them on a later refresh.
   */
  requestCaster(b: BuiltBatch): void {
    const jobs = b.casterJobs
    if (!jobs?.length || b.casterPending || this.disposed) return
    b.casterPending = true
    const pinned: number[] = []
    try {
      for (const g of b.casterModels) if (g.primitives.length) pinned.push(this.client.ensure(g))
    } catch (err) {
      this.client.unpin(pinned)
      b.casterPending = false
      b.casterJobs = null
      console.warn('[batch] caster request failed', err)
      return
    }
    this.counters.casterRequests++
    this.client.merge(jobs).then(result => {
      this.client.unpin(pinned)
      b.casterPending = false
      if (b.alive) b.casterData = result.caster ?? null
      if (!result.caster) b.casterJobs = null
    }, err => {
      this.client.unpin(pinned)
      b.casterPending = false
      b.casterJobs = null
      console.warn('[batch] caster request failed', err)
    })
  }

  private refresh(): void {
    this.applyAll(this.camOrZero())
  }

  private applyAll(cam: Point): void {
    this.trees.update(cam)
    for (const st of this.regions.values()) {
      const b = st.batch
      if (b) for (const l of b.live) this.apply(l, cam)
    }
  }

  /**
   * The last camera position; before the first update (a part made while the camera stands still: WorldObjects only
   * forwards moves), the scene's active camera, else the origin.
   */
  private camOrZero(): Point {
    if (this.lastCam.x === this.lastCam.x) return this.lastCam
    return this.host.scene.activeCamera?.globalPosition ?? ORIGIN
  }

  /**
   * The draw range of a group mesh (§3.8): shown while one of the chunks it replaces is in range (distance − radius <
   * the LOD group's range × the live scale), never by the whole merged group's sphere (RP-1, RP-2); always with the
   * ranges off (setLod).
   */
  private apply(l: LiveMesh, cam: Point): void {
    const range = (GROUP_RANGE_M[l.lod] ?? GROUP_RANGE_M[2]!) * this.rangeScale
    const on = this.visible && (!this.ranges || inRange(l, cam, range))
    if (l.mesh.isEnabled(false) !== on) l.mesh.setEnabled(on)
  }

  meshes(): AbstractMesh[] {
    const out: AbstractMesh[] = []
    for (const st of this.regions.values()) if (st.batch) out.push(...st.batch.meshes)
    out.push(...this.trees.meshes())
    return out
  }

  /** The built batch of an owner (tests, the lab). */
  batchOf(owner: number): RegionBatch | null {
    return this.regions.get(owner)?.batch ?? null
  }

  release(): void {
    for (const owner of [...this.regions.keys()]) this.removeRegion(owner)
    this.regions.clear()
    this.trees.release()
  }

  dispose(): void {
    if (this.disposed) return
    this.release()
    this.disposed = true
    this.client.dispose()
    this.groupMaterials?.dispose()
    this.trees.dispose()
    try {
      this.tables?.dispose?.()
    } catch (err) {
      console.warn('[batch] table dispose failed', err)
    }
    this.proxyMaterial.dispose()
  }
}

/** A region's groups before the merge. */
interface RegionPlan {
  jobs: MergeGroupJob[]
  metas: GroupMeta[]
  slots: BatchSlot[]
  materialSlots: Map<number, ObjectMaterial>
  /** Per group key: its range spheres (centre xyz, radius; one per model and cell). */
  ranges: Map<string, Float32Array>
  /** H-12 MM3: the caster jobs for an on-demand worker request (none when the worker built the caster with the region). */
  casterJobs: MergeGroupJob[]
  casterModels: ModelGeometry[]
}

/**
 * The batch class of a material (materials.ts `batchClass`). The batcher does not know NL's night owners (ambient.json),
 * so a material whose name says light counts as a night owner's: it goes to the lamp group (its glow stays base until
 * NL writes it), never into a group NL cannot light (F9).
 */
function inRange(l: LiveMesh, cam: Point, range: number): boolean {
  const s = l.spheres
  if (!s) {
    const dx = cam.x - l.cx, dy = cam.y - l.cy, dz = cam.z - l.cz
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - l.radius < range
  }
  for (let i = 0; i + 3 < s.length; i += 4) {
    const dx = cam.x - s[i]!, dy = cam.y - s[i + 1]!, dz = cam.z - s[i + 2]!
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) - s[i + 3]! < range) return true
  }
  return false
}

export function classOf(record: MaterialBatchRecord): BatchClass {
  return batchClass(record, LAMP_MATERIAL.test(record.name))
}

/** The table group material key of a record. */
export function tableKey(record: MaterialBatchRecord, cls: BatchClass): GroupMaterialKey {
  return { cutout: record.alpha === 'mask', sheen: record.cls === 'cloth', lamp: cls === 'lamp' }
}
