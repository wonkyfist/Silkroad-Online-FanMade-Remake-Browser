/**
 * Shared, reference-counted model cache for region streaming (docs/FIELDS.md §3.5). One entry per model index (in
 * the world: a glb AssetContainer with its sidecar, converted materials and static-chunk preparation). Regions
 * acquire the models they draw and release them when they unload. At 0 references an entry is not disposed at once:
 * it waits in an LRU and is disposed after `graceS` seconds, or earlier when more than `max` entries wait, so walking
 * back and forth across an area border does not reload anything.
 *
 * Generic over the cached value so the eviction rules are testable without Babylon (the world wiring is in stream.ts).
 *
 * W10-S (docs/BATCHING.md §3.1, F13): `geometryOf` exports a static model's geometry for the region batcher as plain
 * typed arrays per primitive, extracted once per cached model (`CachedModel.geometry`) and only when a batcher asks.
 *
 * T12-M (docs/TREES.md §W3.4, WF10; docs/WAVE_PLAN8.md §6.2): a primitive of the tree tool's glbs (a species' `far.glb`)
 * carries its tier (`tier`: the node's `extras.sroTier`, or its `lod<n>` name) and its third UV set (`uvs3`:
 * TEXCOORD_2, flutter and crown AO), which the merge packs with TEXCOORD_1 (flex, phase) into `sroTreeW`. A primitive
 * without a tier (every retail model) exports exactly what it did (`uvs3` null).
 */
import { Matrix, VertexBuffer, type Material, type Node } from '@babylonjs/core'
import { isBatchableMesh } from './batch/types.ts'
import type { StaticPrep } from './objects.ts'

/** One primitive (one glTF primitive = one Babylon mesh of the container) in model space, float32. */
export interface PrimitiveGeometry {
  /** Its index in `StaticPrep.geometry`. */
  mesh: number
  name: string
  /** The converted material (ObjectMaterials.batchRecord gives its record). */
  material: Material | null
  /**
   * Model-space positions: the glTF node transform baked in, including KHR_mesh_quantization's dequantization scale
   * and offset (all 445 jangan-fields glbs are meshopt + quantized, F13), from normalised integers to float.
   */
  positions: Float32Array
  /** Unit normals (the node transform's inverse transpose, renormalised); null when the primitive has none. */
  normals: Float32Array | null
  /** TEXCOORD_0 / TEXCOORD_1 (the object lightmap; a species' flex and phase), dequantized; null when absent. */
  uvs: Float32Array | null
  uvs2: Float32Array | null
  /**
   * T12-M: TEXCOORD_2 (a species' flutter and crown AO, TREES §3.4), dequantized; extracted only for a tiered primitive
   * (the tree tool's), null otherwise.
   */
  uvs3: Float32Array | null
  /** T12-M: the tree tool's tier of the primitive (1 = LOD1 / P-LOD0, 2 = LOD2 / P-LOD1); 0 = none (every retail model). */
  tier: number
  indices: Uint32Array
  /** The baked node transform mirrors (determinant < 0): the merge flips these triangles to keep them front-facing. */
  mirrored: boolean
  /** The source mesh's side orientation (Babylon's; null = the material's default). */
  sideOrientation: number | null
}

/** A static model's geometry export (the batcher's worker input). */
export interface ModelGeometry {
  primitives: PrimitiveGeometry[]
  vertices: number
  triangles: number
  /** Bytes of every typed array. */
  bytes: number
}

const byPrep = new WeakMap<StaticPrep, ModelGeometry>()

/** The tiers the tree tool tags (its `far.glb`: one node per tier, `extras.sroTier` and the name `lod<tier>`). */
const TIER_NAME = /^lod([12])(?:_primitive\d+)?$/i

/**
 * T12-M: the tree tool's tier of a geometry mesh (packages/convert/src/trees/build.ts `tagTier`): the nearest of the
 * mesh and its ancestors with `extras.sroTier` 1 or 2 (Babylon's glTF loader keeps node extras in
 * `metadata.gltf.extras`) or named `lod1` / `lod2` (a multi-primitive node's meshes are `lod<n>_primitive<i>`). 0: none.
 */
export function treeTierOf(mesh: Node | null): number {
  for (let n: Node | null = mesh; n; n = n.parent) {
    const t = (n.metadata as { gltf?: { extras?: { sroTier?: unknown } } } | null | undefined)?.gltf?.extras?.sroTier
    if (t === 1 || t === 2) return t
    const m = TIER_NAME.exec(n.name)
    if (m) return Number(m[1])
  }
  return 0
}

/** A float32 copy of the first `count` values (null when the source is missing or short). */
function take(src: ArrayLike<number> | null, count: number): Float32Array | null {
  if (!src || src.length < count) return null
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = src[i]!
  return out
}

/**
 * Extracts the geometry of a static preparation (every geometry mesh the thin-instance chunks would clone, minus the
 * meshes tagged 'scatter', 'life' or 'ocean'). Pure reads: the container and its meshes are left untouched.
 */
export function extractModelGeometry(prep: StaticPrep): ModelGeometry {
  const primitives: PrimitiveGeometry[] = []
  let vertices = 0
  let triangles = 0
  let bytes = 0
  const normalMatrix = new Matrix()
  prep.geometry.forEach((mesh, i) => {
    if (!isBatchableMesh(mesh)) return
    const src = mesh.getVerticesData(VertexBuffer.PositionKind)
    if (!src || src.length < 3) return
    const local = prep.locals[i] ?? Matrix.Identity()
    const m = local.m
    const n = Math.floor(src.length / 3)
    const positions = new Float32Array(n * 3)
    for (let v = 0; v < n; v++) {
      const x = src[v * 3]!, y = src[v * 3 + 1]!, z = src[v * 3 + 2]!
      const w = x * m[3]! + y * m[7]! + z * m[11]! + m[15]!
      const iw = w !== 0 && w !== 1 ? 1 / w : 1
      positions[v * 3] = (x * m[0]! + y * m[4]! + z * m[8]! + m[12]!) * iw
      positions[v * 3 + 1] = (x * m[1]! + y * m[5]! + z * m[9]! + m[13]!) * iw
      positions[v * 3 + 2] = (x * m[2]! + y * m[6]! + z * m[10]! + m[14]!) * iw
    }
    const nsrc = mesh.getVerticesData(VertexBuffer.NormalKind)
    let normals: Float32Array | null = null
    if (nsrc && nsrc.length >= n * 3) {
      // A separate matrix for the transpose: Matrix.transposeToRef aliases (BATCHING §4.5 finding 1).
      local.invertToRef(normalMatrix)
      const q = normalMatrix.transpose().m
      normals = new Float32Array(n * 3)
      for (let v = 0; v < n; v++) {
        const a = nsrc[v * 3]!, b = nsrc[v * 3 + 1]!, c = nsrc[v * 3 + 2]!
        const nx = a * q[0]! + b * q[4]! + c * q[8]!
        const ny = a * q[1]! + b * q[5]! + c * q[9]!
        const nz = a * q[2]! + b * q[6]! + c * q[10]!
        const len = Math.hypot(nx, ny, nz) || 1
        normals[v * 3] = nx / len
        normals[v * 3 + 1] = ny / len
        normals[v * 3 + 2] = nz / len
      }
    }
    const uv = mesh.getVerticesData(VertexBuffer.UVKind)
    const uv2 = mesh.getVerticesData(VertexBuffer.UV2Kind)
    // T12-M: only the tree tool's tiered primitives export TEXCOORD_2 (a retail model's geometry is unchanged).
    const tier = treeTierOf(mesh)
    const uv3 = tier ? mesh.getVerticesData(VertexBuffer.UV3Kind) : null
    const idx = mesh.getIndices()
    const indices = idx ? Uint32Array.from(idx) : Uint32Array.from({ length: n }, (_, k) => k)
    const det = m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!)
    const p: PrimitiveGeometry = {
      mesh: i,
      name: mesh.name,
      material: mesh.material,
      positions,
      normals,
      uvs: take(uv, n * 2),
      uvs2: take(uv2, n * 2),
      uvs3: take(uv3, n * 2),
      tier,
      indices,
      mirrored: det < 0,
      sideOrientation: mesh.sideOrientation ?? null,
    }
    primitives.push(p)
    vertices += n
    triangles += Math.floor(indices.length / 3)
    bytes += positions.byteLength + (normals?.byteLength ?? 0) + (p.uvs?.byteLength ?? 0) + (p.uvs2?.byteLength ?? 0) + (p.uvs3?.byteLength ?? 0) + indices.byteLength
  })
  return { primitives, vertices, triangles, bytes }
}

/**
 * The geometry export of a cached static model, made on first use and kept on the entry (`CachedModel.geometry`) and
 * per preparation, so it is extracted once per loaded model and goes when the model is evicted. null for a model
 * without a static preparation (skinned clones).
 */
export function geometryOf(entry: { prep: StaticPrep | null; geometry?: ModelGeometry | null }): ModelGeometry | null {
  if (entry.geometry) return entry.geometry
  if (!entry.prep) return null
  let g = byPrep.get(entry.prep)
  if (!g) byPrep.set(entry.prep, (g = extractModelGeometry(entry.prep)))
  entry.geometry = g
  return g
}

export interface ModelCacheOptions<T> {
  /** Loads model `index` (called once per index while it is cached; a rejection is remembered, never retried). */
  load: (index: number) => Promise<T>
  /** Frees a loaded value (after its grace time, or on dispose). */
  dispose: (value: T, index: number) => void
  /** Seconds an unreferenced entry is kept. */
  graceS: number
  /** Unreferenced entries kept at most (the oldest go first). */
  max: number
  /** Clock in milliseconds (default performance.now). */
  now?: () => number
}

export interface ModelCacheStats {
  /** Entries with a loaded value (referenced or waiting in the LRU). */
  loaded: number
  /** Loaded entries with no reference (the LRU). */
  cached: number
  /** Loads in flight. */
  loading: number
  failed: number
  /** Values disposed so far. */
  disposed: number
}

interface Entry<T> {
  index: number
  owners: Set<number>
  promise: Promise<T>
  value: T | null
  state: 'loading' | 'loaded' | 'failed'
  /** When the last reference went (ms), for the grace time and the LRU order. */
  releasedAt: number
}

export class ModelCache<T> {
  private readonly entries = new Map<number, Entry<T>>()
  private readonly now: () => number
  private disposedCount = 0
  private closed = false
  graceS: number
  max: number

  constructor(private readonly opts: ModelCacheOptions<T>) {
    this.now = opts.now ?? (() => performance.now())
    this.graceS = opts.graceS
    this.max = opts.max
  }

  /**
   * Takes a reference on model `index` for `owner` (a streamed chunk; idempotent per owner) and returns its value once
   * loaded. The reference counts from now on, even while the load is in flight.
   */
  acquire(index: number, owner: number): Promise<T> {
    let e = this.entries.get(index)
    if (!e) {
      const entry: Entry<T> = { index, owners: new Set(), promise: null as unknown as Promise<T>, value: null, state: 'loading', releasedAt: 0 }
      entry.promise = this.opts.load(index).then(value => {
        if (this.closed || this.entries.get(index) !== entry) {
          this.opts.dispose(value, index)
          this.disposedCount++
          throw new Error('model cache disposed')
        }
        entry.value = value
        entry.state = 'loaded'
        return value
      }, err => {
        entry.state = 'failed'
        throw err
      })
      // Nobody may be waiting any more (every owner released): keep the rejection from being unhandled.
      entry.promise.catch(() => {})
      this.entries.set(index, entry)
      e = entry
    }
    e.owners.add(owner)
    return e.promise
  }

  /** Drops `owner`'s reference on model `index` (no-op when it holds none). */
  release(index: number, owner: number): void {
    const e = this.entries.get(index)
    if (!e || !e.owners.delete(owner)) return
    if (e.owners.size === 0) e.releasedAt = this.now()
  }

  /** References on model `index`. */
  refs(index: number): number {
    return this.entries.get(index)?.owners.size ?? 0
  }

  /** Whether model `index` is loaded and not disposed. */
  isLoaded(index: number): boolean {
    return this.entries.get(index)?.state === 'loaded'
  }

  /** The loaded value of model `index`, or null. */
  peek(index: number): T | null {
    return this.entries.get(index)?.value ?? null
  }

  setLimits(graceS: number, max: number): void {
    this.graceS = graceS
    this.max = max
  }

  /**
   * Disposes unreferenced entries whose grace time has passed, then the oldest unreferenced ones beyond `max`, at
   * most `limit` per call (a container dispose costs a few ms: the streamer spreads them over frames). Call once per
   * frame. Returns the number disposed.
   */
  update(now = this.now(), limit = Infinity): number {
    const idle: Entry<T>[] = []
    for (const e of this.entries.values()) if (e.owners.size === 0 && e.state === 'loaded') idle.push(e)
    if (!idle.length) return 0
    idle.sort((a, b) => a.releasedAt - b.releasedAt)
    const graceMs = this.graceS * 1000
    let n = 0
    for (let i = 0; i < idle.length && n < limit; i++) {
      const e = idle[i]!
      if (now - e.releasedAt >= graceMs || idle.length - i > this.max) {
        this.evict(e)
        n++
      }
    }
    return n
  }

  private evict(e: Entry<T>): void {
    this.entries.delete(e.index)
    if (e.value !== null) {
      this.opts.dispose(e.value, e.index)
      this.disposedCount++
    }
    e.value = null
  }

  get stats(): ModelCacheStats {
    let loaded = 0, cached = 0, loading = 0, failed = 0
    for (const e of this.entries.values()) {
      if (e.state === 'loaded') {
        loaded++
        if (e.owners.size === 0) cached++
      } else if (e.state === 'loading') loading++
      else failed++
    }
    return { loaded, cached, loading, failed, disposed: this.disposedCount }
  }

  /** Disposes every loaded value; loads still in flight are disposed when they finish. */
  dispose(): void {
    this.closed = true
    for (const e of [...this.entries.values()]) this.evict(e)
    this.entries.clear()
  }
}
