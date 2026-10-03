/**
 * The ocean part (docs/COAST.md §8; WAVE_PLAN6 §6.1 CST-O): `World.ocean`, made from `manifest.coast` on every path.
 *
 * - **Field:** loaded once (field.ts); until it is there the part draws nothing and `coast` is null.
 * - **Mesh:** one grid (G per preset) drawn as thin instances, one per CDLOD node (cdlod.ts). The `"matrix"` buffer
 *   holds identity matrices (a custom buffer alone draws nothing instanced, F1) and `cdlodNode` the node records; both
 *   are allocated once at the node cap and only the used part is re-uploaded. The mesh stays enabled for its whole life
 *   and only toggles `isVisible` (F2: the enabled-candidates list is never rebuilt by the ocean); it is invisible with
 *   no node selected, so it never renders with 0 instances (F1). `alwaysSelectAsActiveMesh`: Babylon's culling is
 *   bypassed (the selection culls); the bounding box follows the selected nodes, so the transparent sort places the
 *   sea sensibly against the retail water.
 * - **Materials:** the PBR plugin (ocean-plugin.ts) on the PBR path, the Classic ShaderMaterial (ocean-classic.ts) on
 *   the Classic path; a path switch swaps them.
 * - **Waves:** PBR: the worker tile (tile.ts; Medium, and every preset without compute) or the GPU FFT (fft-gpu.ts,
 *   High/Ultra on WebGPU); Classic: three Gerstner waves (gerstner.ts). The sea state follows the weather (weather.ts).
 * - **D27:** the selection stops at the full-fog distance (transmittance < 0.1 %), and with no node selected nothing is
 *   drawn and no tick or dispatch runs.
 */
import {
  Frustum,
  Matrix,
  Mesh,
  Plane,
  Vector3,
  VertexData,
  type AbstractMesh,
  type BaseTexture,
  type Camera,
  type PBRMaterial,
  type Scene,
  type ShaderMaterial,
} from '@babylonjs/core'
import type { CoastAccess, OceanHost, OceanPart } from '../coast/types.ts'
import { WORLD_GROUND_LAYER } from '../layers.ts'
import { heightFogOf } from '../pbr/fog-plugin.ts'
import type { OceanQuality } from '../render/quality.ts'
import { createShorePart } from '../shore/index.ts'
import { CDLOD_LEAF_M, CDLOD_MAX_NODES, CDLOD_RANGE_FACTOR, gridData, selectNodes, type CdlodSettings, type CdlodView } from './cdlod.ts'
import { loadCoastField, type CoastField } from './field.ts'
import { GpuFft, gpuFftSupported } from './fft-gpu.ts'
import { attenuationDepth, attenuationFloor, gerstnerAt, gerstnerHs, gerstnerSet, shallowScale, type GerstnerWave } from './gerstner.ts'
import { ClassicOceanState, bindClassicOcean, createClassicOceanMaterial } from './ocean-classic.ts'
import { CDLOD_ATTRIBUTE, OceanPbrState, createOceanMaterial } from './ocean-plugin.ts'
import type { ShoreFactory, ShoreFrame, ShorePart } from './shore-seam.ts'
import { GPU_TILES_M, WORKER_TILES_M, cascadesFor, type Cascade } from './spectrum.ts'
import { WorkerTile } from './tile.ts'
import { DEFAULT_SEA, SeaWeather, type SeaConfig } from './weather.ts'

/** The grazing sky term's strength (ocean-plugin.ts `sroOcHorizon`; 0 = Babylon's cube reflection only). */
const GRAZING_SKY = 1
/** P-LOOK: how far the mirrored sky blends from the horizon to the zenith as the reflected ray rises (`sroOcZenith.w`). */
const SKY_GRADIENT = 0.85
/** The fog cut: transmittance below 0.1 % (D27). */
const FOG_CUT_LN = Math.log(1000)
/** Foam weights per cascade, longest first (WaterSurface.js: 0.35, 0.45, 0.5, 0.25); the worker's two. */
const FOAM_WEIGHTS_4 = [0.35, 0.45, 0.5, 0.25] as const
const FOAM_WEIGHTS_2 = [0.45, 0.5] as const

/** Options (tests and the viewer). */
export interface OceanOptions {
  /** Run the worker tile in a Worker (default true; false = on the main thread). */
  worker?: boolean
  /** Allow the GPU FFT on High/Ultra (default true). */
  gpu?: boolean
  /** The sea's constants (default DEFAULT_SEA). */
  sea?: Partial<SeaConfig>
  /** The shore (default shore/index.ts createShorePart). */
  shore?: ShoreFactory | null
}

/** The per-frame numbers (the viewer's panel, the bench, the tests). */
export interface OceanStats {
  nodes: number
  visible: boolean
  path: 'pbr' | 'classic' | null
  waves: 'worker-fft' | 'gpu-fft' | 'gerstner' | null
  cutM: number
  hs: number
  selectMs: number
}

/** A wave-height query (CST-A's ships, the camera, the spray): the sea surface's y at glTF (x, z), or null off the sea. */
export interface OceanWaveQuery {
  waveHeightAt(x: number, z: number): number | null
}

export class SroOcean implements OceanPart, OceanWaveQuery {
  private field: CoastField | null = null
  private coastValue: CoastAccess | null = null
  private quality: Readonly<OceanQuality> | null = null
  private mesh: Mesh | null = null
  private grid = 0
  private readonly nodes = new Float32Array(CDLOD_MAX_NODES * 4)
  private readonly pbr = new OceanPbrState()
  private pbrMaterial: PBRMaterial | null = null
  private classicMaterial: ShaderMaterial | null = null
  private readonly classic = new ClassicOceanState()
  private tile: WorkerTile | null = null
  private gpu: GpuFft | null = null
  private gerstner: GerstnerWave[] = []
  private readonly sea: SeaWeather
  private shore: ShorePart | null = null
  private time = 0
  private lastWall: number | null = null
  /** The ocean time of the last wave query (the GPU path's query tile idles 2 s after it). */
  private queried = -Infinity
  private path: 'pbr' | 'classic' | null = null
  private visibleWanted = true
  private pbrReady = false
  private disposed = false
  private readonly frustum = Array.from({ length: 6 }, () => ({ normal: { x: 0, y: 0, z: 0 }, d: 0 }))
  private readonly view: CdlodView = { x: 0, y: 0, z: 0, planes: null, cutM: Infinity }
  // RP-6: per-frame state kept and updated in place (no allocation per frame).
  private readonly planeRefs = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0))
  private readonly lat: CdlodSettings = { originX: 0, originZ: 0, levels: 1, seaLevelM: 0 }
  private readonly waterTest = (x: number, z: number, size: number): boolean => !!this.field?.nodeHasWater(x, z, size)
  private shoreFrame: ShoreFrame | null = null
  readonly stats: OceanStats = { nodes: 0, visible: false, path: null, waves: null, cutM: 0, hs: 0, selectMs: 0 }
  /** Resolves when the field is loaded (or failed: null). */
  readonly loaded: Promise<CoastField | null>

  constructor(readonly host: OceanHost, readonly opts: OceanOptions = {}) {
    this.sea = new SeaWeather({ ...DEFAULT_SEA, ...opts.sea }, 4)
    const w = host.world
    this.loaded = loadCoastField(w.manifest, w.assets).then(
      f => {
        if (this.disposed || !f) return null
        this.field = f
        this.coastValue = { seaLevelM: f.seaLevelM, seaAt: (x, z) => f.seaAt(x, z) }
        try {
          this.shore = (opts.shore === undefined ? createShorePart : opts.shore)?.({ scene: host.scene, world: w, field: f }) ?? null
        } catch (err) {
          console.warn('[ocean] shore failed to start:', err)
        }
        // The wet band follows the path from the load on (HL-1: never a terrain-wide recompile on the first sea frame).
        this.syncShorePath(w.render.mode === 'pbr' ? 'pbr' : 'classic')
        return f
      },
      (err: unknown) => {
        console.warn('[ocean] coast field failed to load; no ocean:', err)
        return null
      },
    )
  }

  get coast(): CoastAccess | null {
    return this.coastValue
  }

  get scene(): Scene {
    return this.host.scene
  }

  /** The preset's ocean row (World.setQuality). */
  setQuality(q: Readonly<OceanQuality> | null): void {
    // World.setQuality runs on every graphics apply: only a different row rebuilds the wave sources.
    if (sameRow(q, this.quality)) return
    this.quality = q
    // The wave source and grid follow at the next update (the path may change at the same time).
    this.dropWaves()
  }

  setMode(mode: 'pbr' | 'classic'): void {
    this.syncShorePath(mode)
  }

  setVisible(on: boolean): void {
    this.visibleWanted = on
    if (!on && this.mesh) this.mesh.isVisible = false
  }

  meshes(): AbstractMesh[] {
    return this.mesh ? [this.mesh] : []
  }

  /** The sea surface's y at (x, z) (null off the sea or before the field loads). */
  waveHeightAt(x: number, z: number): number | null {
    this.queried = this.time
    const f = this.field
    if (!f || !f.seaAt(x, z)) return null
    const s = f.sample(x, z)
    const depth = Math.max(0, -s.elevationM)
    const join = 1 - s.join
    if (this.path === 'classic' || !this.tile?.latest) {
      return f.seaLevelM + gerstnerAt(this.gerstner, x, z, this.time % 3600, depth).dy * join
    }
    const latest = this.tile.latest
    let y = 0
    const cascades = this.tile.cascades
    for (let i = 0; i < cascades.length; i++) {
      const c = cascades[i]!
      const d = latest.disp[i]
      if (!d) continue
      y += bilinearY(d, c.size, x / c.tileM, z / c.tileM) * shallowScale(depth, attenuationDepth(c.tileM), attenuationFloor(c.tileM))
    }
    return f.seaLevelM + y * join
  }

  update(camera: Camera | null, dt: number): void {
    if (this.disposed) return
    const f = this.field
    const q = this.quality
    if (!f || !q || !camera) {
      if (this.mesh) this.mesh.isVisible = false
      return
    }
    const w = this.host.world
    const path: 'pbr' | 'classic' = w.render.mode === 'pbr' ? 'pbr' : 'classic'
    if (path !== this.path) {
      this.path = path
      this.dropWaves()
    }
    // Every frame, not only with a sea node (LG-1: a switch to Low far inland removes the wet band too).
    this.syncShorePath(path)
    this.ensureMesh(q.grid)
    const mesh = this.mesh!
    // The ocean's clock: the world's frame time, or the wall clock when a frame reports none (a paused engine clock,
    // a manually pumped frame), clamped so a stall never jumps the waves.
    const wall = now() / 1000
    const step = dt > 0 ? dt : this.lastWall === null ? 0 : wall - this.lastWall
    this.lastWall = wall
    this.time += Math.max(0, Math.min(0.1, step))
    const t = this.time % 3600
    const frame = w.weatherState
    const rebuilt = this.sea.update(frame, dt)
    this.ensureWaves(q, path)
    if (rebuilt || (path === 'classic' && !this.gerstner.length)) {
      this.gerstner = gerstnerSet(this.sea.params)
      this.classic.setWaves(this.gerstner)
    }
    if (this.tile) {
      this.tile.setParams(this.sea.params)
      this.tile.setKnobs(this.sea.tileFor(this.tile.cascades.length))
    }
    this.gpu?.setParams(this.sea.params, this.sea.tileFor(this.gpu.cascades.length))

    // Selection (D27: cut at the full fog).
    const t0 = now()
    const cam = camera.globalPosition
    const v = this.view
    v.x = cam.x
    v.y = cam.y
    v.z = cam.z
    v.cutM = this.fogCut(camera, q)
    v.planes = this.planes(camera)
    const lat = this.lat
    lat.originX = f.coast.field.x0
    lat.originZ = f.coast.field.z0
    lat.levels = q.levels
    lat.seaLevelM = f.seaLevelM
    const count = selectNodes(v, lat, this.waterTest, this.nodes)
    this.stats.selectMs = now() - t0
    this.stats.nodes = count
    this.stats.cutM = v.cutM
    this.stats.path = path
    mesh.thinInstanceCount = count
    if (count > 0) mesh.thinInstancePartialBufferUpdate(CDLOD_ATTRIBUTE, count, 0)
    const active = count > 0 && this.visibleWanted

    // Waves (idle with no node).
    // On the GPU path the worker tile only feeds the CPU query: it ticks while someone asked within the last 2 s.
    this.tile?.update(this.time, active && (!this.gpu || this.time - this.queried < 2))
    if (active) this.gpu?.update(t)
    const hs = path === 'classic' ? gerstnerHs(this.gerstner) : this.gpu?.hs ?? this.tile?.latest?.hs ?? 0
    this.stats.hs = hs

    const ready = path === 'pbr' ? this.bindPbr(f, q, camera, t, hs) : this.bindClassic(f, camera, t)
    mesh.isVisible = active && ready
    this.stats.visible = mesh.isVisible
    if (mesh.isVisible) this.fitBounds(count, f.seaLevelM)
    if (active && this.shore) {
      try {
        const sf = (this.shoreFrame ??= { time: 0, seaLevelM: 0, hs: 0, periodS: 0, swellDir: this.sea.swellDir, storm: 0, rain: 0, quality: q, path })
        sf.time = t
        sf.seaLevelM = f.seaLevelM
        sf.hs = hs
        sf.periodS = this.sea.periodS
        sf.swellDir = this.sea.swellDir
        sf.storm = this.sea.frameKnobs.storm
        sf.rain = this.sea.frameKnobs.rain
        sf.quality = q
        sf.path = path
        this.shore.update(sf)
      } catch (err) {
        console.warn('[ocean] shore update failed:', err)
        this.shore = null
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.dropWaves()
    this.shore?.dispose()
    this.shore = null
    this.mesh?.dispose(false, false)
    this.mesh = null
    this.pbrMaterial?.dispose(false, false)
    this.pbrMaterial = null
    this.classicMaterial?.dispose(false, false)
    this.classicMaterial = null
    this.field?.dispose()
    this.field = null
    this.coastValue = null
  }

  // ---- internals ----------------------------------------------------------------------------------------------------

  private ensureMesh(grid: number): void {
    if (this.mesh && this.grid === grid) return
    const scene = this.host.scene
    const old = this.mesh
    const g = gridData(grid)
    const mesh = new Mesh('ocean', scene)
    const vd = new VertexData()
    vd.positions = g.positions
    vd.normals = g.normals
    vd.indices = g.indices
    vd.applyToMesh(mesh, false)
    // Tagged for the batcher's refusal (D7); `ocean` lets the viewer and the bench read the part's stats.
    mesh.metadata = { sroWorld: 'ocean', ocean: this }
    mesh.layerMask |= WORLD_GROUND_LAYER
    mesh.isPickable = false
    mesh.alwaysSelectAsActiveMesh = true
    mesh.doNotSyncBoundingInfo = true
    mesh.applyFog = false
    mesh.receiveShadows = false
    // F1: identity matrices (the placement is the vertex stage's), then the node records; allocated once at the cap.
    const identity = new Float32Array(CDLOD_MAX_NODES * 16)
    for (let i = 0; i < CDLOD_MAX_NODES; i++) Matrix.IdentityReadOnly.copyToArray(identity, i * 16)
    mesh.thinInstanceSetBuffer('matrix', identity, 16, true)
    mesh.thinInstanceSetBuffer(CDLOD_ATTRIBUTE, this.nodes, 4, false)
    mesh.thinInstanceCount = 0
    mesh.isVisible = false
    mesh.material = this.path === 'classic' ? this.classicMaterial : this.pbrMaterial
    this.mesh = mesh
    this.grid = grid
    old?.dispose(false, false)
  }

  private ensureWaves(q: Readonly<OceanQuality>, path: 'pbr' | 'classic'): void {
    const scene = this.host.scene
    const mesh = this.mesh!
    if (path === 'classic') {
      this.classicMaterial ??= createClassicOceanMaterial(scene, false)
      if (mesh.material !== this.classicMaterial) mesh.material = this.classicMaterial
      mesh.receiveShadows = false
      this.stats.waves = 'gerstner'
      return
    }
    if (!this.pbrMaterial) {
      this.pbrMaterial = createOceanMaterial(scene, this.pbr).material
      this.pbr.shore = this.shore
    }
    if (mesh.material !== this.pbrMaterial) mesh.material = this.pbrMaterial
    mesh.receiveShadows = q.shadows
    if (this.tile || this.gpu) return
    const useGpu = q.waves === 'gpu-fft' && (this.opts.gpu ?? true) && gpuFftSupported(scene.getEngine())
    if (useGpu) {
      try {
        this.gpu = new GpuFft(scene, cascadesFor(GPU_TILES_M, q.fftSize || 128), (this.opts.worker ?? true))
        this.configureCascades(this.gpu.cascades, FOAM_WEIGHTS_4)
        this.pbr.waves = this.gpu.texture
        this.pbr.setSwitches({ lerp: false, cascades4: true })
        this.stats.waves = 'gpu-fft'
      } catch (err) {
        console.warn('[ocean] GPU FFT failed to start; using the worker tile:', err)
        this.gpu?.dispose()
        this.gpu = null
      }
    }
    // The worker tile: Medium's, and the CPU query's everywhere.
    const cascades = cascadesFor(WORKER_TILES_M, q.waves === 'worker-fft' && q.fftSize ? q.fftSize : 64)
    this.tile = new WorkerTile(scene, cascades, q.tickHz || 20, { worker: this.opts.worker ?? true, textures: !this.gpu })
    this.tile.setParams(this.sea.params)
    if (!this.gpu) {
      this.configureCascades(cascades, FOAM_WEIGHTS_2)
      this.pbr.waves = this.tile.texture
      this.pbr.setSwitches({ lerp: true, cascades4: false })
      this.stats.waves = 'worker-fft'
    }
    this.pbr.refresh()
  }

  private configureCascades(cascades: readonly Cascade[], foam: readonly number[]): void {
    for (let c = 0; c < 4; c++) {
      const cs = cascades[c]
      if (!cs) {
        this.pbr.k[c]!.set(0, 1, 1, 0)
        continue
      }
      this.pbr.k[c]!.set(1 / cs.tileM, cs.tileM / cs.size, attenuationDepth(cs.tileM), attenuationFloor(cs.tileM))
    }
    this.pbr.w.set(foam[0] ?? 0, foam[1] ?? 0, foam[2] ?? 0, foam[3] ?? 0)
  }

  private syncShorePath(path: 'pbr' | 'classic'): void {
    if (!this.shore?.setPath) return
    try {
      this.shore.setPath(path)
    } catch (err) {
      console.warn('[ocean] shore path failed:', err)
    }
  }

  private dropWaves(): void {
    this.tile?.dispose()
    this.tile = null
    this.gpu?.dispose()
    this.gpu = null
    this.pbr.waves = null
    this.stats.waves = null
  }

  /** The full-fog distance (D27) or the far plane. */
  private fogCut(camera: Camera, q: Readonly<OceanQuality>): number {
    const far = camera.maxZ > 0 ? camera.maxZ : 2000
    if (!q.fogCut) return far
    const scene = this.host.scene
    if (scene.fogMode === 0) return far
    const hf = heightFogOf(scene)
    if (this.path === 'pbr' && hf?.active && hf.a.w > 0 && hf.a.x > 0) return Math.min(far, hf.a.z + FOG_CUT_LN / hf.a.x)
    return Math.min(far, scene.fogEnd > 0 ? scene.fogEnd : far)
  }

  private planes(camera: Camera): CdlodView['planes'] {
    const ps = this.planeRefs
    Frustum.GetPlanesToRef(camera.getTransformationMatrix(), ps)
    for (let i = 0; i < 6; i++) {
      const p = ps[i]!
      const o = this.frustum[i]!
      o.normal.x = p.normal.x
      o.normal.y = p.normal.y
      o.normal.z = p.normal.z
      o.d = p.d
    }
    return this.frustum
  }

  private bindPbr(f: CoastField, q: Readonly<OceanQuality>, camera: Camera, t: number, hs: number): boolean {
    const s = this.pbr
    const w = this.host.world
    const water = w.water.ensurePbrState()
    s.field = f.texture(this.host.scene)
    s.normal = water.normal
    s.frames = water.frames ?? w.water.classicFrames.texture
    const knobs = this.sea.frameKnobs
    const sw = this.sea.swellDir
    s.a.set(f.seaLevelM, t, hs, this.sea.periodS)
    s.s.set(sw[0], sw[1], knobs.storm, knobs.rain)
    const cam = camera.globalPosition
    s.cam.set(cam.x, cam.y, cam.z, q.grid)
    s.lat.set(f.coast.field.x0, f.coast.field.z0, CDLOD_LEAF_M, CDLOD_RANGE_FACTOR)
    s.fieldXf.copyFrom(f.xf)
    if (this.gpu) s.t.set(0, 0, 0, 4)
    else if (this.tile) s.t.set(this.tile.lerp, this.tile.prevBase, this.tile.nextBase, this.tile.cascades.length)
    const sky = w.skyState
    const k = sky.keyLight
    s.sun.set(k.dir.x, k.dir.y, k.dir.z, k.intensity * (0.2126 * k.color[0] + 0.7152 * k.color[1] + 0.0722 * k.color[2]))
    s.rough.set(knobs.roughWindMs, knobs.rain, 0, 0)
    const frames = w.water.classicFrames
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
    s.wa.set(Math.floor(nowMs / Math.max(1, frames.frameMs)) % Math.max(1, frames.count), (nowMs / 1000) % 3600, knobs.rain, w.weather.u.wxA.w)
    s.wb.copyFrom(water.b)
    s.wc.copyFrom(water.c)
    s.wc.w = Math.abs(water.c.w) * (w.render.quality.waterDepthShore ? -1 : 1)
    const fog = heightFogOf(this.host.scene)
    if (fog?.active) {
      s.horizon.set(fog.color.x, fog.color.y, fog.color.z, GRAZING_SKY)
      // P-LOOK: the zenith = the horizon × the sky's hemisphere ratio (up / horizon, per channel), the same units.
      const a = sky.ambient
      const r = (c: 0 | 1 | 2) => Math.min(1.5, Math.max(0.2, a.sky[c] / Math.max(a.horizon[c], 1e-4)))
      s.zenith.set(fog.color.x * r(0), fog.color.y * r(1), fog.color.z * r(2), SKY_GRADIENT)
    } else {
      s.horizon.set(0, 0, 0, 0)
      s.zenith.set(0, 0, 0, 0)
    }
    s.setSwitches({ ripple: (w.weather.rippleTexture as BaseTexture | null) ?? null })
    if (s.ready !== this.pbrReady) {
      this.pbrReady = s.ready
      s.refresh()
    }
    return s.ready && (this.gpu ? this.gpu.ready : !!this.tile?.ready)
  }

  private bindClassic(f: CoastField, camera: Camera, t: number): boolean {
    const mat = this.classicMaterial
    if (!mat) return false
    const w = this.host.world
    const scene = this.host.scene
    const c = this.classic
    const env = w.sky.envFor()
    c.water.set(env.water[0], env.water[1], env.water[2], 1)
    const frames = w.water.classicFrames
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
    c.params.set(Math.floor(nowMs / Math.max(1, frames.frameMs)) % Math.max(1, frames.count), scene.fogMode !== 0 ? 1 : 0, 0, 0)
    c.fog.set(scene.fogStart, scene.fogEnd, scene.fogMode !== 0 ? 1 : 0, 0)
    c.fogColor.set(scene.fogColor.r, scene.fogColor.g, scene.fogColor.b, 1)
    const s = this.pbr
    const sw = this.sea.swellDir
    s.a.set(f.seaLevelM, t, this.stats.hs, this.sea.periodS)
    s.s.set(sw[0], sw[1], this.sea.frameKnobs.storm, this.sea.frameKnobs.rain)
    const cam = camera.globalPosition
    s.cam.set(cam.x, cam.y, cam.z, this.grid)
    s.lat.set(f.coast.field.x0, f.coast.field.z0, CDLOD_LEAF_M, CDLOD_RANGE_FACTOR)
    bindClassicOcean(mat, c, { a: s.a, s: s.s, cam: s.cam, lat: s.lat, fieldXf: f.xf }, frames.texture, f.texture(scene))
    this.shore?.bind({ vec4: (n, v) => mat.setVector4(n, v), texture: (n, tex) => mat.setTexture(n, tex) })
    return !!frames.texture
  }

  /** The mesh's bounding box = the selected nodes' (the transparent sort's distance). */
  private fitBounds(count: number, sl: number): void {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
    for (let i = 0; i < count; i++) {
      const o = i * 4
      x0 = Math.min(x0, this.nodes[o]!)
      z0 = Math.min(z0, this.nodes[o + 1]!)
      x1 = Math.max(x1, this.nodes[o]! + this.nodes[o + 2]!)
      z1 = Math.max(z1, this.nodes[o + 1]! + this.nodes[o + 2]!)
    }
    const b = this.mesh!.getBoundingInfo()
    b.reConstruct(BOX_MIN.set(x0, sl - 3, z0), BOX_MAX.set(x1, sl + 3, z1))
  }
}

/** Two preset rows are the same (shallow: every field a primitive but the reflection block). */
function sameRow(a: Readonly<OceanQuality> | null, b: Readonly<OceanQuality> | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  for (const k of Object.keys(a) as Array<keyof OceanQuality>) {
    if (k === 'reflection') {
      if (JSON.stringify(a.reflection) !== JSON.stringify(b.reflection)) return false
    } else if (a[k] !== b[k]) return false
  }
  return true
}

const BOX_MIN = new Vector3()
const BOX_MAX = new Vector3()

/** Bilinear Dy of a tile layer (RGBA float, n × n, wrapping) at tile coordinates (u, v) in tiles. */
function bilinearY(d: Float32Array, n: number, u: number, v: number): number {
  const fx = (u - Math.floor(u)) * n, fz = (v - Math.floor(v)) * n
  const i0 = Math.floor(fx), j0 = Math.floor(fz)
  const tx = fx - i0, tz = fz - j0
  const at = (i: number, j: number) => d[(((j % n) + n) % n * n + (((i % n) + n) % n)) * 4 + 1]!
  const a = at(i0, j0) + (at(i0 + 1, j0) - at(i0, j0)) * tx
  const b = at(i0, j0 + 1) + (at(i0 + 1, j0 + 1) - at(i0, j0 + 1)) * tx
  return a + (b - a) * tz
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
