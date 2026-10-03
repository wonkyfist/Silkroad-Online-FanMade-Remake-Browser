/**
 * GRASS_LIFE's own grass (docs/GRASS_LIFE.md §2–§4; lane GL-F): the 'field' ground cover WorldScatter hands its
 * regions, level and frame to (scatter.ts GroundCover, §8.1). Medium, High and Ultra draw it; Low keeps the retail
 * scatter (Classic never makes a field: the Low guard).
 *
 * - **Data:** each registered region is baked (grass/bake.ts) in ≤ 1 ms row slices inside `update`, nearest first,
 *   never inside a streamer job (§3.1 fact-check: a region is ≈ 15–25 ms of work). A region registers when the
 *   streamer makes it ready; its object floors are in the nav by then (the streamed nav loads every object model and
 *   instance up front, nav.ts loadNavStreamed), so registration only enqueues. The region's terrain lightmap is fetched
 *   at 192² (Assets.image; off the main thread) into the bake's A channel: the baked shadow of trees and houses on the
 *   grass (Q4) on every preset, where the CSM tap only covers High+.
 * - **The window** (grass/window.ts): 256 m around the camera, re-centred every 32 m, re-filled when a bake finishes or
 *   a region goes; uploaded at most once per frame (RGBA8 256² field + 129² heights).
 * - **Drawing:** three thin-instance meshes (near, mid, far: one draw each for all grass and flowers in view), one
 *   ShaderMaterial on the grass skeleton (grass/shaders.ts) that follows the facade through `adopt`, no shadow
 *   casting, no picking, tagged `metadata.sroWorld = 'scatter'` (never batched), frozen world matrices, `alwaysSelect
 *   AsActiveMesh` with the cell cull of grass/cull.ts. A tier with no cell is hidden with `isVisible` (never
 *   `setEnabled`: that dirties wave 9's EnabledMeshCandidates), and a visible tier never has 0 instances (Babylon would
 *   draw it once, un-instanced, at the origin).
 * - **Per frame:** the cull (only uploaded when it changed), the player's push, the pixel-width floor. No allocation.
 * - **The meadow ring** (docs/GRASS_FAR.md, ring B; Medium and High, not Low): sparse tufts and flower dots from where
 *   the near blades drop out to ≈ 255 m (Medium) / 310 m (High), drawn as three more thin-instance meshes (B1, B2, B3:
 *   one draw each) with their own material (grass/ring-shaders.ts: the skeleton and its chunks, the CSM tap stripped:
 *   real-time shadows stay the near ring's) over their own window (grass/ring-window.ts: 832 m at 2 m, filled in
 *   ≤ RING_SLICE_MS row slices from each region's 2 × 2 boxed bake, `coarseGrass`, made when the bake lands).
 */
import {
  Constants,
  Frustum,
  Matrix,
  Mesh,
  Observable,
  Plane,
  RawTexture,
  ShaderLanguage,
  ShaderMaterial,
  Texture,
  Vector3,
  Vector4,
  VertexData,
  type BaseTexture,
  type Camera,
  type Scene,
} from '@babylonjs/core'
import type { WorldRegion } from '../../../convert/src/world/manifest.ts'
import type { RegionData } from '../regions.ts'
import { GRASS_CSM_DEFINE } from '../render/grass-chunks.ts'
import type { GroundCover, ScatterHost, ScatterLevel, WorldScatter } from '../scatter.ts'
import { SCATTER_TAG } from './types.ts'
import {
  GRASS_BUSY_REACH,
  GRASS_REGION_M,
  RegionGrassBake,
  grassBakeSource,
  grassNeighbourBit,
  grassTileTable,
  type GrassBakeSource,
  type GrassSea,
  type GrassTileTable,
} from './bake.ts'
import { GRASS_LEVELS, cullGrass, grassCullOut, type GrassCullOut, type GrassLevel } from './cull.ts'
import { GRASS_LODS, buildPatch, type GrassDensity, type GrassPatch } from './patch.ts'
import { GRASS_RING_FIELD_SAMPLER, GRASS_RING_HEIGHT_SAMPLER, GRASS_RING_SHADER, grassRingShaders } from './ring-shaders.ts'
import { GRASS_RING_HEIGHT_GRID, GRASS_RING_TEXELS, GRASS_RING_WINDOW_M, GrassRingWindow, coarseGrass, type GrassRingRegion } from './ring-window.ts'
import { GRASS_RING_LODS, buildRingPatch, cullGrassRing, grassRingCullOut, type GrassRingCullOut, type GrassRingPatch } from './ring.ts'
import {
  GRASS_ATTRIBUTES,
  GRASS_FACE_CAMERA,
  GRASS_FIELD_SAMPLER,
  GRASS_HEIGHT_GRID,
  GRASS_HEIGHT_SAMPLER,
  GRASS_MIN_BLADE_PX,
  GRASS_PUSH_M,
  GRASS_SHADER,
  GRASS_WINDOW_M,
  grassPixelPerMetre,
  grassShaders,
  registerSkeletonShader,
} from './shaders.ts'
import { grassTintWind } from './tint.ts'
import { GrassWindow, type GrassWindowRegion } from './window.ts'

/** What the wildlife reads from the grass (GL-L: anchors, landing spots, the critters' ground). */
export interface GrassFieldAccess {
  /** Grass density 0..1 at glTF (x, z) (0 outside the window). */
  densityAt(x: number, z: number): number
  /** The meadow (flower) mask 0..1. */
  meadowAt(x: number, z: number): number
  /** The baked light 0..1 (1: no lightmap; < 0.8 under trees and eaves). */
  lightAt(x: number, z: number): number
  /** The ground height the grass stands on (null outside the window). */
  heightAt(x: number, z: number): number | null
  /** grField (x0, z0, hMin, hRange), by reference: bind it on the life materials, it follows the window. */
  readonly fieldVector: Vector4
  /** scRegion (x0, lightmap on, z0 + 256, 0), by reference. */
  readonly regionVector: Vector4
  /** The window texture (bind as `scLightmap`: its A channel is the baked light). */
  readonly fieldTexture: BaseTexture
  /** The height texture (bind as `grFieldH`). */
  readonly heightTexture: BaseTexture
  /** Fired after the window was filled again (re-centred, a bake landed, a region went). */
  readonly onChange: Observable<void>
  /** W12-SB (S-GRASS; I-12 step 0: reachable through grassFieldOf): GrassField.invalidate. */
  invalidate?(rect?: GrassRect | null): number[]
  /** W12-SB (S-GRASS): GrassField.setMask. */
  setMask?(regionId: number, mask: ArrayLike<number> | null): boolean
}

export interface GrassFieldStats {
  level: ScatterLevel
  regions: number
  baked: number
  /** Regions waiting for (or in) their bake. */
  pending: number
  /** Cells drawn per tier (near, mid, far). */
  cells: [number, number, number]
  /** GRASS_FAR: meadow-ring cells drawn per sub-ring (B1, B2, B3). */
  ring: [number, number, number]
  /** GRASS_FAR: ring window fills done, and the time spent in its slices (last frame, worst frame; ms). */
  ringFills: number
  ringSliceMs: number
  ringWorstSliceMs: number
  /** Vertices and triangles submitted per frame. */
  vertices: number
  triangles: number
  /** The longest bake slice so far and the last region's bake time in all (ms). */
  worstSliceMs: number
  lastRegionBakeMs: number
  /** The last window fill (ms) and the last frame's cull (ms). */
  fillMs: number
  cullMs: number
  /** Window fills so far. */
  fills: number
  /** Instance uploads so far (a frame whose cull did not change uploads nothing). */
  uploads: number
}

export interface GrassFieldOptions {
  /** Clock in ms (default performance.now). */
  now?: () => number
  /** Bake budget per frame (ms, default 1). */
  sliceMs?: number
  /** Bake budget per frame while a region near the camera is not baked yet (ms, default 4: a load or a teleport). */
  urgentSliceMs?: number
  /**
   * The baked light of a region: its lightmap as RGBA (any size; row 0 = south). Default: the region's terrain
   * lightmap through the host's Assets at 192². null: none (A stays 255).
   */
  lightmap?: ((region: WorldRegion) => Promise<{ width: number; height: number; data: ArrayLike<number> }> | null) | null
  /**
   * W12-SB (WORLD_EDITOR D55, seam S-GRASS): a region's grass / flower mask image (192 × 192 RGBA8 in file order: row
   * 0 = north, like every world-edits PNG, packages/shared world-edits), fetched only for a region whose manifest entry
   * lists one (`grassMask`); the field turns it south-up (the bake's order). Default: that file through the host's
   * Assets. null: masks are never fetched.
   */
  mask?: ((region: WorldRegion, file: string) => Promise<{ width: number; height: number; data: ArrayLike<number> }> | null) | null
}

/** A rectangle of the ground in glTF metres (x east, z glTF; the corners in any order). */
export interface GrassRect {
  x0: number
  z0: number
  x1: number
  z1: number
}

/** The grass mask file of a region's manifest entry (W12-CV's `grassMask`), or null. */
export function regionGrassMask(region: WorldRegion): string | null {
  const f = (region as WorldRegion & { grassMask?: unknown }).grassMask
  return typeof f === 'string' && f ? f : null
}

interface Entry extends GrassWindowRegion, GrassRingRegion {
  readonly id: number
  /** GRASS_FAR: the bake boxed down to 2 m (grass/ring-window.ts coarseGrass), made when the bake (or its light) lands. */
  coarse: Uint8Array | null
  readonly region: WorldRegion
  readonly data: RegionData
  /** Made when its first slice runs (registration only enqueues). */
  bake: RegionGrassBake | null
  grass: Uint8Array | null
  bakeMs: number
  /** Bake again: a neighbour the bake lacked has arrived (the edge feather reads past the border, bake.ts). */
  rebake: boolean
  /** Its height range (invalidate recomputes it after an edit). */
  hMin: number
  hMax: number
  /** W12-SB: the editor's grass / flower mask (null: none), and whether its fetch is still on its way (no bake yet). */
  mask: Uint8Array | null
  maskPending: boolean
}

/** Concurrent lightmap decodes. */
const LIGHTMAP_LOADS = 2
/** A region whose square is this near the camera (m) bakes with the urgent budget. */
const URGENT_M = 96
/** The ring window's fill budget per frame (ms; a whole fill is ≈ 3 ms of row work). */
const RING_SLICE_MS = 0.6

export class GrassField implements GroundCover, GrassFieldAccess {
  readonly style = 'field' as const
  readonly window = new GrassWindow()
  readonly fieldVector = new Vector4(0, 0, 0, 1)
  readonly regionVector = new Vector4(0, 1, GRASS_WINDOW_M, 0)
  readonly onChange = new Observable<void>()
  readonly stats: GrassFieldStats = {
    level: 'off', regions: 0, baked: 0, pending: 0, cells: [0, 0, 0], ring: [0, 0, 0], ringFills: 0, ringSliceMs: 0, ringWorstSliceMs: 0,
    vertices: 0, triangles: 0, worstSliceMs: 0, lastRegionBakeMs: 0, fillMs: 0, cullMs: 0, fills: 0, uploads: 0,
  }
  /** GRASS_FAR's meadow ring: its window, textures, material and the B1 / B2 / B3 meshes. */
  readonly ringWindow = new GrassRingWindow()
  readonly ringFieldTexture: RawTexture
  readonly ringHeightTexture: RawTexture
  readonly ringMaterial: ShaderMaterial
  readonly fieldTexture: RawTexture
  readonly heightTexture: RawTexture
  readonly material: ShaderMaterial
  private readonly scene: Scene
  private readonly meshList: Mesh[] = []
  private readonly ringMeshes: Mesh[] = []
  /** meshList then ringMeshes (one array: meshes() is asked by the scatter every frame). */
  private readonly allMeshes: Mesh[] = []
  private readonly ringPatches: ({ vertices: number; triangles: number } | null)[] = [null, null, null]
  private readonly ringOut: GrassRingCullOut = grassRingCullOut()
  private readonly ringLastCounts: [number, number, number] = [-1, -1, -1]
  private readonly ringLastUploaded: Float32Array[] = [new Float32Array(0), new Float32Array(0), new Float32Array(0)]
  private readonly ringVector = new Vector4(0, 0, 0, 1)
  private readonly ringRegion = new Vector4(0, 1, GRASS_RING_WINDOW_M, 0)
  private readonly ringLod0 = new Vector4()
  private readonly ringLod1 = new Vector4()
  private readonly ringLod2 = new Vector4()
  private readonly ringStyle = new Vector4(0, 1, 1, 1)
  private readonly ringView = new Vector4(0, GRASS_MIN_BLADE_PX, 0, 0)
  private readonly wind = new Vector4(0.8, 0.6, 0, 0)
  private ringKey = ''
  private ringDirty = true
  private readonly unadoptRing: () => void
  /** Vertices and triangles of each tier's patch (the arrays live on the GPU). */
  private readonly patches: ({ vertices: number; triangles: number } | null)[] = [null, null, null]
  private readonly entries = new Map<number, Entry>()
  private readonly queue: Entry[] = []
  private readonly table: GrassTileTable
  private readonly out: GrassCullOut = grassCullOut()
  private readonly lastCounts: [number, number, number] = [-1, -1, -1]
  /** Each tier's instance data as last uploaded (compared with the cull's output). */
  private readonly lastUploaded: Float32Array[] = [new Float32Array(0), new Float32Array(0), new Float32Array(0)]
  private readonly planes: Plane[] = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0))
  private readonly viewProj = new Matrix()
  private readonly lod0 = new Vector4()
  private readonly lod1 = new Vector4(0, 0, 1, 1)
  private readonly styleVec = new Vector4()
  private readonly player = new Vector4(0, -1e6, 0, GRASS_PUSH_M)
  private readonly view = new Vector4(0, GRASS_MIN_BLADE_PX, 0, 0)
  private readonly tint = new Vector4(1, 1, 1, 0.5)
  private readonly tmpTarget = new Vector3()
  private readonly now: () => number
  private readonly sliceMs: number
  private readonly urgentSliceMs: number
  private readonly lightmapOf: GrassFieldOptions['lightmap']
  private readonly maskOf: GrassFieldOptions['mask']
  private readonly lightQueue: Entry[] = []
  private lightActive = 0
  private lightFailed = false
  /** The coast's sea once it has arrived (World.coast loads after the first bakes), and the regions to clear of it. */
  private seaSeen: GrassSea | null = null
  private readonly seaQueue: Entry[] = []
  private level: GrassLevel | null = null
  private levelName: ScatterLevel = 'off'
  private density: GrassDensity | null = null
  private dirty = true
  private frame = 0
  private uploaded = -1
  private disposed = false
  private unadopt: () => void = () => {}

  constructor(private readonly scatter: (Pick<WorldScatter, 'adopt'> & { readonly sharedUniforms?: ReadonlyMap<string, unknown> }) | null, private readonly host: ScatterHost, opts: GrassFieldOptions = {}) {
    this.scene = host.scene
    this.now = opts.now ?? (() => performance.now())
    this.sliceMs = opts.sliceMs ?? 1
    this.urgentSliceMs = opts.urgentSliceMs ?? 4
    this.lightmapOf = opts.lightmap === undefined ? this.defaultLightmap() : opts.lightmap
    this.maskOf = opts.mask === undefined ? this.defaultMask() : opts.mask
    this.table = grassTileTable(host.manifest.tiles)
    const scene = this.scene
    const w = this.window
    this.fieldTexture = new RawTexture(w.field, GRASS_WINDOW_M, GRASS_WINDOW_M, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
    this.fieldTexture.name = 'grassField'
    this.fieldTexture.wrapU = this.fieldTexture.wrapV = Texture.CLAMP_ADDRESSMODE
    this.heightTexture = new RawTexture(w.heightBytes, GRASS_HEIGHT_GRID, GRASS_HEIGHT_GRID, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.NEAREST_SAMPLINGMODE)
    this.heightTexture.name = 'grassHeight'
    this.heightTexture.wrapU = this.heightTexture.wrapV = Texture.CLAMP_ADDRESSMODE
    this.material = this.makeMaterial()
    for (const lod of GRASS_LODS) {
      const m = new Mesh(`grass_field_${['near', 'mid', 'far'][lod]}`, scene)
      m.isPickable = false
      m.alwaysSelectAsActiveMesh = true
      m.doNotSyncBoundingInfo = true
      m.receiveShadows = false
      m.isVisible = false
      m.metadata = { sroWorld: SCATTER_TAG, grassLod: lod }
      m.material = this.material
      this.meshList.push(m)
    }
    const rf = this.ringWindow.front
    this.ringFieldTexture = new RawTexture(rf.field, GRASS_RING_TEXELS, GRASS_RING_TEXELS, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
    this.ringFieldTexture.name = 'grassRingField'
    this.ringFieldTexture.wrapU = this.ringFieldTexture.wrapV = Texture.CLAMP_ADDRESSMODE
    this.ringHeightTexture = new RawTexture(rf.heightBytes, GRASS_RING_HEIGHT_GRID, GRASS_RING_HEIGHT_GRID, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.NEAREST_SAMPLINGMODE)
    this.ringHeightTexture.name = 'grassRingHeight'
    this.ringHeightTexture.wrapU = this.ringHeightTexture.wrapV = Texture.CLAMP_ADDRESSMODE
    const ring = this.makeRingMaterial()
    this.ringMaterial = ring.material
    this.unadoptRing = ring.unadopt
    for (const lod of GRASS_RING_LODS) {
      const m = new Mesh(`grass_ring_b${lod + 1}`, scene)
      m.isPickable = false
      m.alwaysSelectAsActiveMesh = true
      m.doNotSyncBoundingInfo = true
      m.receiveShadows = false
      m.isVisible = false
      m.metadata = { sroWorld: SCATTER_TAG, grassLod: 3 + lod, grassRing: lod }
      m.material = this.ringMaterial
      this.ringMeshes.push(m)
    }
    this.allMeshes.push(...this.meshList, ...this.ringMeshes)
  }

  /**
   * The meadow ring's material: the ring shaders, adopted like the near one (the scatter's uniforms, defines, chunk
   * fallbacks) except the CSM tap: `SRO_GRASS_CSM` never turns on here (real-time shadows stay the near ring's).
   */
  private makeRingMaterial(): { material: ShaderMaterial; unadopt: () => void } {
    const src = grassRingShaders()
    registerSkeletonShader(GRASS_RING_SHADER, src)
    const mat = new ShaderMaterial('grass_ring', this.scene, GRASS_RING_SHADER, {
      attributes: [...GRASS_ATTRIBUTES],
      uniforms: src.uniforms,
      samplers: src.samplers,
      shaderLanguage: this.scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    })
    mat.backFaceCulling = false
    const setDefine = mat.setDefine.bind(mat)
    mat.setDefine = (name: string, value: boolean | string) => setDefine(name, name === GRASS_CSM_DEFINE ? false : value)
    const unadopt = this.scatter?.adopt(mat) ?? (() => {})
    mat.setTexture(GRASS_RING_FIELD_SAMPLER, this.ringFieldTexture)
    mat.setTexture(GRASS_RING_HEIGHT_SAMPLER, this.ringHeightTexture)
    mat.setTexture('scLightmap', this.ringFieldTexture)
    mat.setVector4('grRing', this.ringVector)
    mat.setVector4('scRegion', this.ringRegion)
    mat.setVector4('scTint', this.tint)
    mat.setVector4('grRingLod0', this.ringLod0)
    mat.setVector4('grRingLod1', this.ringLod1)
    mat.setVector4('grRingLod2', this.ringLod2)
    mat.setVector4('grRingStyle', this.ringStyle)
    mat.setVector4('grView', this.ringView)
    mat.setVector4('grWind', this.wind)
    mat.setArray4('grPal', this.table.palette)
    return { material: mat, unadopt }
  }

  private makeMaterial(): ShaderMaterial {
    const src = grassShaders()
    registerSkeletonShader(GRASS_SHADER, src)
    const mat = new ShaderMaterial('grass_field', this.scene, GRASS_SHADER, {
      attributes: [...GRASS_ATTRIBUTES],
      uniforms: src.uniforms,
      samplers: src.samplers,
      shaderLanguage: this.scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
    })
    mat.backFaceCulling = false
    this.unadopt = this.scatter?.adopt(mat) ?? (() => {})
    mat.setTexture(GRASS_FIELD_SAMPLER, this.fieldTexture)
    mat.setTexture(GRASS_HEIGHT_SAMPLER, this.heightTexture)
    mat.setTexture('scLightmap', this.fieldTexture)
    mat.setVector4('grField', this.fieldVector)
    mat.setVector4('scRegion', this.regionVector)
    mat.setVector4('scTint', this.tint)
    mat.setVector4('grLod0', this.lod0)
    mat.setVector4('grLod1', this.lod1)
    mat.setVector4('grStyle', this.styleVec)
    mat.setVector4('grPlayer', this.player)
    mat.setVector4('grView', this.view)
    mat.setArray4('grPal', this.table.palette)
    return mat
  }

  private defaultLightmap(): GrassFieldOptions['lightmap'] {
    const assets = this.host.assets
    if (typeof assets?.image !== 'function') return null
    return region => region.lightmap ? assets.image(region.lightmap.file, GRASS_REGION_M) : null
  }

  private defaultMask(): GrassFieldOptions['mask'] {
    const assets = this.host.assets
    if (typeof assets?.image !== 'function') return null
    return (_region, file) => assets.image(file)
  }

  // ---- GroundCover ------------------------------------------------------------------------------------------------

  addRegion(data: RegionData): void {
    if (this.disposed) return
    this.removeRegion(data.region.id)
    const e: Entry = {
      id: data.region.id,
      region: data.region,
      data,
      ox: Math.round(data.region.origin[0]),
      oz: Math.round(data.region.origin[2]),
      heights: data.terrain.heights,
      ...heightRange(data.terrain.heights),
      bake: null,
      grass: null,
      coarse: null,
      bakeMs: 0,
      rebake: false,
      mask: null,
      maskPending: false,
    }
    this.entries.set(e.id, e)
    this.queue.push(e)
    this.fetchMask(e)
    // a neighbour baked (or baking) without this region bakes again: its edge feather reads this region's cells
    for (const n of this.entries.values()) {
      const dx = Math.round((e.ox - n.ox) / GRASS_REGION_M), dz = Math.round((n.oz - e.oz) / GRASS_REGION_M)
      if (n === e || Math.abs(dx) > 1 || Math.abs(dz) > 1 || !n.bake || n.bake.neighbourMask < 0) continue
      if (n.bake.neighbourMask & grassNeighbourBit(dx, dz)) continue
      n.rebake = true
      if (!this.queue.includes(n)) this.queue.push(n)
    }
    this.dirty = true
    this.syncStats()
  }

  removeRegion(id: number): boolean {
    const e = this.entries.get(id)
    if (!e) return false
    this.entries.delete(id)
    this.ringDirty = true
    const qi = this.queue.indexOf(e)
    if (qi >= 0) this.queue.splice(qi, 1)
    const li = this.lightQueue.indexOf(e)
    if (li >= 0) this.lightQueue.splice(li, 1)
    const si = this.seaQueue.indexOf(e)
    if (si >= 0) this.seaQueue.splice(si, 1)
    this.dirty = true
    this.syncStats()
    return true
  }

  setLevel(level: ScatterLevel): void {
    this.levelName = level
    this.stats.level = level
    this.level = GRASS_LEVELS[level] ?? null
    const l = this.level
    if (!l) {
      for (const m of this.meshList) m.isVisible = false
      for (const m of this.ringMeshes) m.isVisible = false
      return
    }
    this.lod0.set(l.fade2[0], l.fade2[1], l.fade1[0], l.fade1[1])
    this.lod1.set(l.cut0[0], l.cut0[1], 1, 1)
    this.styleVec.set(l.width, GRASS_FACE_CAMERA, l.flowers, l.density.blades)
    this.view.z = l.band
    if (!this.density || this.density.clumpGrid !== l.density.clumpGrid || this.density.blades !== l.density.blades) {
      this.density = l.density
      for (const lod of GRASS_LODS) this.applyPatch(this.meshList[lod]!, buildPatch(lod, l.density))
    }
    this.lastCounts.fill(-1)
    const r = l.ring
    if (!r) {
      for (const m of this.ringMeshes) m.isVisible = false
      this.stats.ring.fill(0)
      return
    }
    this.ringLod0.set(r.in[0], r.in[1], r.thin1[0], r.thin1[1])
    this.ringLod1.set(r.thin2[0], r.thin2[1], r.out[0], r.out[1])
    this.ringLod2.set(r.dots[0], r.dots[1], r.dots[2], r.dots[3])
    this.ringStyle.set(r.width, r.keep2, r.keep3, 1)
    this.ringView.z = l.band
    const key = `${r.grid}|${r.keep2}|${r.keep3}`
    if (key !== this.ringKey) {
      this.ringKey = key
      for (const lod of GRASS_RING_LODS) this.applyRingPatch(this.ringMeshes[lod]!, buildRingPatch(lod, r))
    }
    this.ringLastCounts.fill(-1)
  }

  private applyRingPatch(mesh: Mesh, patch: GrassRingPatch): void {
    this.ringPatches[patch.lod] = { vertices: patch.vertices, triangles: patch.triangles }
    const vd = new VertexData()
    vd.positions = patch.positions
    vd.indices = patch.indices
    vd.applyToMesh(mesh, false)
    mesh.setVerticesData('bladeA', patch.bladeA, false, 4)
    mesh.setVerticesData('bladeB', patch.bladeB, false, 4)
    mesh.thinInstanceSetBuffer('matrix', this.ringOut.buffers[patch.lod], 16, false)
    mesh.thinInstanceCount = 1
    mesh.doNotSyncBoundingInfo = true
    mesh.freezeWorldMatrix()
  }

  private applyPatch(mesh: Mesh, patch: GrassPatch): void {
    this.patches[patch.lod] = { vertices: patch.vertices, triangles: patch.triangles }
    const vd = new VertexData()
    vd.positions = patch.positions
    vd.indices = patch.indices
    vd.applyToMesh(mesh, false)
    mesh.setVerticesData('bladeA', patch.bladeA, false, 4)
    mesh.setVerticesData('bladeB', patch.bladeB, false, 4)
    mesh.thinInstanceSetBuffer('matrix', this.out.buffers[patch.lod], 16, false)
    mesh.thinInstanceCount = 1
    mesh.doNotSyncBoundingInfo = true
    mesh.freezeWorldMatrix()
  }

  ready(): Promise<void> {
    return Promise.resolve()
  }

  /** The near field's three meshes, then the meadow ring's three (GRASS_FAR). */
  meshes(): Mesh[] {
    return this.allMeshes
  }

  update(camera: { x: number; y: number; z: number } | null): void {
    if (this.disposed || !camera) return
    const level = this.level
    if (!level) return
    if (this.window.needsCentre(camera.x, camera.z)) {
      this.window.centre(camera.x, camera.z)
      this.dirty = true
    }
    this.bakeSlice(camera.x, camera.z)
    this.syncSea()
    if (this.dirty) this.fill()
    // The terrain lightmap switch (Options / the viewer): World.terrainParams makes an object, so read it twice a second.
    if (this.frame++ % 30 === 0) this.regionVector.y = (this.host.terrainParams?.().lightmap ?? true) ? 1 : 0
    const cam = this.scene.activeCamera
    this.feed(cam, camera)
    const t0 = this.now()
    let planes: Plane[] | null = null
    if (cam) {
      // This frame's view (Camera.getTransformationMatrix is the last render's product).
      cam.getViewMatrix().multiplyToRef(cam.getProjectionMatrix(), this.viewProj)
      Frustum.GetPlanesToRef(this.viewProj, this.planes)
      planes = this.planes
    }
    cullGrass(this.window, camera.x, camera.z, level, planes, this.out)
    this.commit()
    this.updateRing(camera, planes)
    this.stats.cullMs = this.now() - t0
  }

  /** GRASS_FAR: the ring window's fill slice, the wind, the ring's cull and its upload. */
  private updateRing(camera: { x: number; y: number; z: number }, planes: Plane[] | null): void {
    const level = this.level
    if (!level?.ring) return
    const w = this.ringWindow
    if (w.needsCentre(camera.x, camera.z) || (this.ringDirty && !w.busy)) {
      this.ringDirty = false
      w.start(camera.x, camera.z, this.entries.values())
    }
    if (w.busy) {
      const t0 = this.now()
      const deadline = t0 + RING_SLICE_MS
      if (w.step(() => this.now() >= deadline)) this.uploadRing()
      const ms = this.now() - t0
      this.stats.ringSliceMs = ms
      if (ms > this.stats.ringWorstSliceMs) this.stats.ringWorstSliceMs = ms
    } else this.stats.ringSliceMs = 0
    this.feedWind(level.carpet.sheen)
    cullGrassRing(w.front, camera.x, camera.z, level, planes, this.ringOut)
    this.commitRing()
  }

  /** The ring window's new front to the GPU (textures and the vectors that place them). */
  private uploadRing(): void {
    const f = this.ringWindow.front
    this.ringFieldTexture.update(f.field)
    this.ringHeightTexture.update(f.heightBytes)
    this.ringVector.set(f.x0, f.z0, f.hMin, f.hRange)
    this.ringRegion.x = f.x0
    this.ringRegion.z = f.z0 + GRASS_RING_WINDOW_M
    this.stats.ringFills = this.ringWindow.fills
  }

  /**
   * The wind the tips' sheen follows: the weather's (`wxB` on the scatter: direction, strength, its sway clock), else a
   * calm breeze on the field's own clock. `sheen` = the level's share (0: off).
   */
  private feedWind(sheen: number): void {
    const wx = this.scatter?.sharedUniforms?.get('wxB')
    grassTintWind(wx instanceof Vector4 ? wx : null, sheen, this.now() / 1000, this.wind)
    this.ringRegion.y = this.regionVector.y
  }

  /** The ring's cull to its meshes (as commit: a sub-ring's instances are uploaded only when its cells changed). */
  private commitRing(): void {
    const counts = this.ringOut.counts
    let verts = 0, tris = 0
    for (const lod of GRASS_RING_LODS) {
      const m = this.ringMeshes[lod]!
      const n = counts[lod]
      const patch = this.ringPatches[lod]
      if (n > 0 && patch) {
        verts += n * patch.vertices
        tris += n * patch.triangles
      }
      if (n === 0) {
        if (m.isVisible) m.isVisible = false
        this.ringLastCounts[lod] = 0
        continue
      }
      const buf = this.ringOut.buffers[lod]
      const len = n * 16
      let last = this.ringLastUploaded[lod]!
      let same = n === this.ringLastCounts[lod]
      for (let i = 0; same && i < len; i++) same = buf[i] === last[i]
      if (!same) {
        m.thinInstanceCount = n
        m.thinInstanceBufferUpdated('matrix')
        this.ringLastCounts[lod] = n
        if (last.length < len) last = this.ringLastUploaded[lod] = new Float32Array(buf.length)
        last.set(buf.subarray(0, len))
        this.stats.uploads++
      }
      if (!m.isVisible) m.isVisible = true
    }
    this.stats.ring[0] = counts[0]
    this.stats.ring[1] = counts[1]
    this.stats.ring[2] = counts[2]
    this.stats.vertices += verts
    this.stats.triangles += tris
  }

  /** The player's push (the camera's target: the game's orbit camera follows the character) and the pixel floor. */
  private feed(cam: Camera | null, camera: { x: number; y: number; z: number }): void {
    const target = (cam as (Camera & { target?: Vector3 }) | null)?.target
    const p = target instanceof Vector3 ? target : this.tmpTarget.set(camera.x, camera.y, camera.z)
    this.player.set(p.x, p.y, p.z, GRASS_PUSH_M)
    const engine = this.scene.getEngine()
    const fov = cam && 'fov' in cam && typeof cam.fov === 'number' ? cam.fov : 0.8
    this.view.x = grassPixelPerMetre(fov, engine.getRenderHeight(true))
    this.ringView.x = this.view.x
  }

  /** Hands the cull to the meshes: a tier's instances are uploaded only when its cells changed. */
  private commit(): void {
    const counts = this.out.counts
    let verts = 0, tris = 0
    for (const lod of GRASS_LODS) {
      const m = this.meshList[lod]!
      const n = counts[lod]
      const patch = this.patches[lod]
      if (n > 0 && patch) {
        verts += n * patch.vertices
        tris += n * patch.triangles
      }
      if (n === 0) {
        if (m.isVisible) m.isVisible = false
        this.lastCounts[lod] = 0
        continue
      }
      const buf = this.out.buffers[lod]
      // GL-L12: the cull result itself is compared with the last upload (a hash let a rigid move keep the old cells).
      const len = n * 16
      let last = this.lastUploaded[lod]!
      let same = n === this.lastCounts[lod]
      for (let i = 0; same && i < len; i++) same = buf[i] === last[i]
      if (!same) {
        m.thinInstanceCount = n
        m.thinInstanceBufferUpdated('matrix')
        this.lastCounts[lod] = n
        if (last.length < len) last = this.lastUploaded[lod] = new Float32Array(buf.length)
        last.set(buf.subarray(0, len))
        this.stats.uploads++
      }
      if (!m.isVisible) m.isVisible = true
    }
    this.stats.cells[0] = counts[0]
    this.stats.cells[1] = counts[1]
    this.stats.cells[2] = counts[2]
    this.stats.vertices = verts
    this.stats.triangles = tris
  }

  /** Bakes the nearest pending regions within this frame's budget. */
  private bakeSlice(cx: number, cz: number): void {
    if (!this.queue.length) return
    // Nearest first (the queue is short: the resident regions); a region whose mask is on its way waits for it.
    let best = -1, bestD = Infinity
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i]!.maskPending) continue
      const d = regionDistance(this.queue[i]!, cx, cz)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0) return
    const start = this.now()
    const deadline = start + (bestD <= URGENT_M ? this.urgentSliceMs : this.sliceMs)
    const stop = () => this.now() >= deadline
    while (this.queue.length) {
      const e = this.queue[best]!
      const t0 = this.now()
      if (!e.bake || e.rebake) this.startBake(e)
      const done = e.bake!.step(stop)
      e.bakeMs += this.now() - t0
      if (done) {
        this.queue.splice(best, 1)
        e.grass = e.bake!.data
        this.refreshCoarse(e)
        this.stats.lastRegionBakeMs = e.bakeMs
        this.dirty = true
      }
      if (stop() || !this.queue.length) break
      bestD = Infinity
      best = -1
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i]!.maskPending) continue
        const d = regionDistance(this.queue[i]!, cx, cz)
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best < 0) break
    }
    const ms = this.now() - start
    if (ms > this.stats.worstSliceMs) this.stats.worstSliceMs = ms
    this.syncStats()
  }

  private fill(): void {
    const t0 = this.now()
    this.dirty = false
    const w = this.window
    w.fill(this.entries.values())
    this.fieldTexture.update(w.field)
    this.heightTexture.update(w.heightBytes)
    this.fieldVector.set(w.x0, w.z0, w.hMin, w.hRange)
    this.regionVector.x = w.x0
    this.regionVector.z = w.z0 + GRASS_WINDOW_M
    this.uploaded = w.version
    this.stats.fills++
    this.stats.fillMs = this.now() - t0
    this.onChange.notifyObservers()
  }

  /**
   * The coast's sea (ScatterHost.coast): new bakes read it per row; when it first arrives, the regions baked (or begun)
   * before it whose grass reaches down to the sea level are cleared of it, one region per frame.
   */
  private syncSea(): void {
    if (!this.seaSeen) {
      const sea = this.host.coast?.() ?? null
      if (!sea) return
      this.seaSeen = sea
      for (const e of this.entries.values()) if (e.bake) this.seaQueue.push(e)
    }
    const e = this.seaQueue.shift()
    if (e && this.entries.get(e.id) === e && e.bake?.clearSea(this.seaSeen) && e.grass) {
      this.refreshCoarse(e)
      this.dirty = true
    }
  }

  /** GRASS_FAR: the region's 2 m box of its bake (the ring window copies it) again, and a ring refill. */
  private refreshCoarse(e: Entry): void {
    if (!e.grass) return
    e.coarse = coarseGrass(e.grass, e.coarse ?? undefined)
    this.ringDirty = true
  }

  /**
   * A region's first slice: its bake, and the fetch of its baked light. A bake again (`rebake`) keeps the light the
   * earlier one has (a lightmap still on its way lands in the new bake) and the old grass shows until it is done.
   */
  private startBake(e: Entry): void {
    const prev = e.bake
    e.rebake = false
    e.bake = new RegionGrassBake(grassBakeSource(e.data, e.mask), this.table, {
      occupied: this.host.occupied ? (x, z, y) => this.host.occupied!(x, z, y) : null,
      sea: this.host.coast ? () => this.host.coast!() : null,
      neighbours: (dx, dz) => this.neighbourSource(e, dx, dz),
    })
    if (prev) e.bake.copyLight(prev.data)
    else if (this.lightmapOf && e.region.lightmap) {
      this.lightQueue.push(e)
      this.pumpLightmaps()
    }
  }

  /** The loaded region next to `e` (dx east, dz north), as a bake reads it. */
  private neighbourSource(e: Entry, dx: number, dz: number): GrassBakeSource | null {
    const x = e.ox + dx * GRASS_REGION_M, z = e.oz - dz * GRASS_REGION_M
    for (const n of this.entries.values()) if (n.ox === x && n.oz === z) return grassBakeSource(n.data)
    return null
  }

  /** W12-SB: fetches a region's manifest-listed grass mask; its bake waits for it (a failed fetch bakes without). */
  private fetchMask(e: Entry): void {
    const file = regionGrassMask(e.region)
    const load = file && this.maskOf ? this.maskOf(e.region, file) : null
    if (!load) return
    e.maskPending = true
    load.then(img => {
      // setMask (the editor's live mask) wins over a fetch still on its way
      if (this.disposed || this.entries.get(e.id) !== e || !e.maskPending) return
      if (img.width !== GRASS_REGION_M || img.height !== GRASS_REGION_M) throw new Error(`${file}: ${img.width} × ${img.height}, expected ${GRASS_REGION_M} × ${GRASS_REGION_M}`)
      // file rows run north → south; the bake's run south → north
      const row = GRASS_REGION_M * 4
      const m = new Uint8Array(GRASS_REGION_M * row)
      for (let j = 0; j < GRASS_REGION_M; j++) m.set(Array.prototype.slice.call(img.data, (GRASS_REGION_M - 1 - j) * row, (GRASS_REGION_M - j) * row) as number[], j * row)
      e.mask = m
    }).catch(err => {
      if (!this.disposed) console.warn(`[world] grass mask of region ${e.id} (the grass there is unpainted):`, err)
    }).finally(() => {
      e.maskPending = false
    })
  }

  /**
   * W12-SB (seam S-GRASS): the ground changed under `rect` (glTF metres; null: everywhere): an editor's height stroke,
   * texture paint, water or mask change. Every resident region within the edge feather's reach of it (bake.ts
   * GRASS_BUSY_REACH cells) takes its height range again and bakes again in the usual slices; its old grass shows until
   * the new bake is done, and the window refills. Returns the regions queued.
   */
  invalidate(rect: GrassRect | null = null): number[] {
    if (this.disposed) return []
    const reach = (GRASS_BUSY_REACH + 1) * 2
    const x0 = rect ? Math.min(rect.x0, rect.x1) - reach : -Infinity, x1 = rect ? Math.max(rect.x0, rect.x1) + reach : Infinity
    const z0 = rect ? Math.min(rect.z0, rect.z1) - reach : -Infinity, z1 = rect ? Math.max(rect.z0, rect.z1) + reach : Infinity
    const out: number[] = []
    for (const e of this.entries.values()) {
      // the region spans x ox … ox + 192 and z oz − 192 … oz
      if (e.ox > x1 || e.ox + GRASS_REGION_M < x0 || e.oz - GRASS_REGION_M > z1 || e.oz < z0) continue
      const r = heightRange(e.heights)
      e.hMin = r.hMin
      e.hMax = r.hMax
      if (e.bake) e.rebake = true
      if (!this.queue.includes(e)) this.queue.push(e)
      out.push(e.id)
    }
    if (out.length) {
      this.dirty = true
      this.ringDirty = true
      this.syncStats()
    }
    return out
  }

  /**
   * W12-SB: the editor's live grass / flower mask of a resident region (192 × 192 RGBA8 south-up, the bake's order and
   * the shared GrassLayer's z × 192 + x; null: none), baked
   * again with it (and its neighbours, whose edge feather reads its cells). False when the region is not resident.
   */
  setMask(regionId: number, mask: ArrayLike<number> | null): boolean {
    const e = this.entries.get(regionId)
    if (!e || this.disposed) return false
    if (mask && mask.length < GRASS_REGION_M * GRASS_REGION_M * 4) throw new Error(`grass mask of region ${regionId}: ${mask.length} bytes, expected ${GRASS_REGION_M * GRASS_REGION_M * 4}`)
    e.mask = mask ? Uint8Array.from(mask) : null
    e.maskPending = false
    if (e.bake) e.rebake = true
    if (!this.queue.includes(e)) this.queue.push(e)
    this.dirty = true
    this.syncStats()
    return true
  }

  private pumpLightmaps(): void {
    while (this.lightActive < LIGHTMAP_LOADS && this.lightQueue.length && !this.disposed) {
      const e = this.lightQueue.shift()!
      const load = this.lightmapOf ? this.lightmapOf(e.region) : null
      if (!load) continue
      this.lightActive++
      load.then(img => {
        if (this.disposed || this.entries.get(e.id) !== e || !e.bake) return
        e.bake.setLight(img.data, img.width, img.height)
        if (e.grass) {
          this.refreshCoarse(e)
          this.dirty = true
        }
      }, err => {
        if (!this.disposed && !this.lightFailed) console.warn(`[world] grass lightmap of region ${e.id} (the grass there has no baked shadow):`, err)
        this.lightFailed = true
      }).finally(() => {
        this.lightActive--
        this.pumpLightmaps()
      })
    }
  }

  private syncStats(): void {
    this.stats.regions = this.entries.size
    this.stats.pending = this.queue.length
    this.stats.baked = this.entries.size - this.queue.length
  }

  // ---- GrassFieldAccess ---------------------------------------------------------------------------------------------

  densityAt(x: number, z: number): number {
    return this.window.densityAt(x, z)
  }

  meadowAt(x: number, z: number): number {
    return this.window.meadowAt(x, z)
  }

  lightAt(x: number, z: number): number {
    return this.window.lightAt(x, z)
  }

  heightAt(x: number, z: number): number | null {
    return this.window.heightAt(x, z)
  }

  /** The current Options level. */
  get grassLevel(): ScatterLevel {
    return this.levelName
  }

  /** GRASS_FAR: whether the ring window holds every region change (no fill running or waiting). */
  get ringSettled(): boolean {
    return !this.ringWindow.busy && !this.ringDirty
  }

  /** Whether the window's textures hold its current fill. */
  get uploadedVersion(): number {
    return this.uploaded
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unadopt()
    this.unadoptRing()
    for (const m of this.meshList) m.dispose(false, false)
    for (const m of this.ringMeshes) m.dispose(false, false)
    this.meshList.length = 0
    this.ringMeshes.length = 0
    this.allMeshes.length = 0
    this.material.dispose(false, false)
    this.ringMaterial.dispose(false, false)
    this.fieldTexture.dispose()
    this.heightTexture.dispose()
    this.ringFieldTexture.dispose()
    this.ringHeightTexture.dispose()
    this.ringWindow.cancel()
    this.entries.clear()
    this.queue.length = 0
    this.lightQueue.length = 0
    this.onChange.clear()
  }
}

/** A region's lowest and highest terrain height. */
function heightRange(h: ArrayLike<number>): { hMin: number; hMax: number } {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < h.length; i++) {
    const v = h[i]!
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return lo <= hi ? { hMin: lo, hMax: hi } : { hMin: 0, hMax: 0 }
}

/** 2D distance from (x, z) to a region's square. */
function regionDistance(r: { ox: number; oz: number }, x: number, z: number): number {
  const dx = x < r.ox ? r.ox - x : x > r.ox + GRASS_REGION_M ? x - r.ox - GRASS_REGION_M : 0
  const dz = z < r.oz - GRASS_REGION_M ? r.oz - GRASS_REGION_M - z : z > r.oz ? z - r.oz : 0
  return Math.hypot(dx, dz)
}
