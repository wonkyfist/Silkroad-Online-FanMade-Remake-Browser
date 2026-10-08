/**
 * Babylon.js side of @sro/fx: loads exported effects (programs, PNG textures, glb meshes) and draws an
 * FxSimulation as CPU-built geometry, one dynamic mesh per drawing node.
 *
 * Why CPU geometry: every element needs its own matrix, colour and texture window, and billboards need the
 * camera. Building the vertices on the CPU keeps the GPU side to Babylon's StandardMaterial (unlit, vertex colour
 * times texture), which ships both GLSL and WGSL, so WebGPU and WebGL2 work without runtime shader downloads.
 *
 * The scene must use the right-handed system (scene.useRightHandedSystem = true), like every glTF in this project:
 * the programs are in glTF space.
 *
 * Blend: 'add' = SRCALPHA/ONE (Constants.ALPHA_ADD), 'alpha' = SRCALPHA/INVSRCALPHA (ALPHA_COMBINE),
 * 'oneone' = ONE/ONE. The Direct3D texture stage (texture x diffuse, 2x, 4x, or texture only) is folded into the
 * vertex colour, so the fragment is simply texture x vertex colour.
 */
import {
  Color3,
  Constants,
  Material,
  Mesh,
  StandardMaterial,
  Texture,
  VertexBuffer,
  type Camera,
  type Scene,
  type TransformNode,
} from '@babylonjs/core'
import { readGlbMesh, type FxMeshData } from './glb.ts'
import { identity3, type M3, type V3 } from './math.ts'
import { FX_PLATE_SIZE, validateFxEffect, type FxEffect, type FxMaterial, type FxNode, type FxStageOp } from './program.ts'
import { FxSimulation, type FxElement, type FxRootPose, type FxSimulationOptions } from './simulation.ts'

export type FxFetch = (url: string) => Promise<ArrayBuffer>

const defaultFetch: FxFetch = async url => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.arrayBuffer()
}

/** Caches programs, meshes, textures and materials for one scene. */
export class FxLibrary {
  private programs = new Map<string, Promise<FxEffect>>()
  private meshes = new Map<string, Promise<FxMeshData | null>>()
  private meshData = new Map<string, FxMeshData | null>()
  private textures = new Map<string, Texture>()
  private materials = new Map<string, StandardMaterial>()

  /**
   * @param baseUrl where work/out is served (e.g. '/out/'); program, texture and mesh URLs are relative to it.
   */
  constructor(readonly scene: Scene, readonly baseUrl = '/out/', private readonly fetchBytes: FxFetch = defaultFetch) {}

  /** Program URL of an effect key (Particles.pk2 path), e.g. 'skill/china/cold_ganggi_keep_a.efp'. */
  static programPath(key: string): string {
    return 'fx/efp/' + key.replace(/\\/g, '/').toLowerCase().replace(/\.[^./]*$/, '') + '.json'
  }

  /** Loads (and caches) a program plus the meshes it uses. */
  load(key: string): Promise<FxEffect> {
    const path = FxLibrary.programPath(key)
    let p = this.programs.get(path)
    if (!p) {
      p = (async () => {
        const bytes = await this.fetchBytes(this.baseUrl + path)
        const effect = JSON.parse(new TextDecoder().decode(bytes)) as FxEffect
        const problem = validateFxEffect(effect)
        if (problem) throw new Error(`${path}: ${problem}`)
        await Promise.all(effect.meshes.map(m => this.mesh(m)))
        return effect
      })()
      this.programs.set(path, p)
      p.catch(() => this.programs.delete(path))
    }
    return p
  }

  /** Registers an already parsed program (tests, tools); meshes must be provided with addMesh. */
  addProgram(effect: FxEffect): void {
    this.programs.set(FxLibrary.programPath(effect.key), Promise.resolve(effect))
  }

  addMesh(url: string, data: FxMeshData): void {
    this.meshData.set(url, data)
    this.meshes.set(url, Promise.resolve(data))
  }

  private mesh(url: string): Promise<FxMeshData | null> {
    if (!url) return Promise.resolve(null)
    let p = this.meshes.get(url)
    if (!p) {
      p = this.fetchBytes(this.baseUrl + url)
        .then(b => readGlbMesh(new Uint8Array(b)))
        .catch(err => {
          console.warn(`fx: mesh ${url}: ${(err as Error).message}`)
          return null
        })
        .then(d => {
          this.meshData.set(url, d)
          return d
        })
      this.meshes.set(url, p)
    }
    return p
  }

  /** Mesh geometry once loaded (null while loading, missing or failed). */
  meshGeometry(url: string): FxMeshData | null {
    return this.meshData.get(url) ?? null
  }

  texture(url: string): Texture | null {
    if (!url) return null
    let t = this.textures.get(url)
    if (!t) {
      // Direct3D UVs: (0, 0) is the top-left texel, so no Y flip.
      t = new Texture(this.baseUrl + url, this.scene, { invertY: false, samplingMode: Texture.TRILINEAR_SAMPLINGMODE })
      t.hasAlpha = true
      this.textures.set(url, t)
    }
    return t
  }

  /** One shared unlit material per (texture, blend, cull). */
  material(effect: FxEffect, m: FxMaterial): StandardMaterial {
    const url = m.texture >= 0 ? effect.textures[m.texture]! : ''
    const noTexture = m.colorOp === 'diffuse' && m.alphaOp === 'diffuse'
    const key = `${noTexture ? '' : url}|${m.blend}|${m.cull}`
    let mat = this.materials.get(key)
    if (!mat) {
      mat = new StandardMaterial(`fx:${key}`, this.scene)
      mat.disableLighting = true
      mat.emissiveColor = Color3.White()
      mat.diffuseColor = Color3.Black()
      mat.specularColor = Color3.Black()
      mat.ambientColor = Color3.Black()
      mat.fogEnabled = false
      const tex = noTexture ? null : this.texture(url)
      if (tex) {
        mat.diffuseTexture = tex
        mat.useAlphaFromDiffuseTexture = true
      }
      mat.transparencyMode = Material.MATERIAL_ALPHABLEND
      mat.alphaMode = m.blend === 'add' ? Constants.ALPHA_ADD : m.blend === 'oneone' ? Constants.ALPHA_ONEONE : Constants.ALPHA_COMBINE
      mat.disableDepthWrite = true
      mat.backFaceCulling = m.cull !== 'none'
      mat.cullBackFaces = m.cull !== 'front'
      mat.sideOrientation = this.scene.useRightHandedSystem ? Material.CounterClockWiseSideOrientation : Material.ClockWiseSideOrientation
      this.materials.set(key, mat)
    }
    return mat
  }

  /**
   * Perf audit (docs/PERF_AUDIT.md): a disposed instance's batch meshes wait here, at most this many per (material,
   * kind, geometry), for the next instance that needs the same kind of batch (0 = no pool: they are disposed). A new
   * Babylon mesh per hit effect, and its dispose (a splice through every scene mesh), cost ≈ 1 ms a frame with 50
   * fighters in view. Hidden meshes in the pool draw nothing.
   */
  poolLimit = 0
  /** Perf audit: a batch that drew nothing and drew nothing last frame uploads nothing (it is hidden either way). */
  static skipEmptyUploads = true
  private readonly pool = new Map<string, Batch[]>()
  private readonly geometryIds = new WeakMap<FxMeshData, number>()
  private nextGeometryId = 0

  /** The pool key of a batch: material, kind, geometry. */
  batchKey(material: StandardMaterial, kind: string, geometry: FxMeshData | null): string {
    let g = 0
    if (geometry) {
      g = this.geometryIds.get(geometry) ?? 0
      if (!g) this.geometryIds.set(geometry, (g = ++this.nextGeometryId))
    }
    return `${material.uniqueId}|${kind}|${g}`
  }

  /** A pooled batch of `key`, hidden and empty (undefined: none waiting). */
  takeBatch(key: string): Batch | undefined {
    return this.pool.get(key)?.pop()
  }

  /** Keeps `b` for a later instance; false when the pool of its key is full (the caller disposes it). */
  giveBatch(b: Batch): boolean {
    if (this.poolLimit <= 0 || b.mesh.isDisposed()) return false
    let list = this.pool.get(b.poolKey)
    if (!list) this.pool.set(b.poolKey, (list = []))
    if (list.length >= this.poolLimit) return false
    b.drawn = 0
    b.uploadedEmpty = false
    b.mesh.isVisible = false
    list.push(b)
    return true
  }

  /** Batch meshes waiting in the pool (tests, the bench). */
  get pooled(): number {
    let n = 0
    for (const l of this.pool.values()) n += l.length
    return n
  }

  dispose(): void {
    for (const l of this.pool.values()) for (const b of l) b.dispose()
    this.pool.clear()
    for (const m of this.materials.values()) m.dispose()
    for (const t of this.textures.values()) t.dispose()
    this.materials.clear()
    this.textures.clear()
  }
}

/** Root pose from scene nodes: position from `position` (e.g. a bone), rotation from `rotation` (default: none). */
export function nodePose(position: TransformNode, rotation?: TransformNode | null, offset: V3 = [0, 0, 0]): () => FxRootPose {
  return () => {
    const w = position.computeWorldMatrix(true).m
    let rot: M3 = identity3()
    if (rotation) {
      const r = rotation.computeWorldMatrix(true).m
      // Babylon matrices are row-vector (rows = axes); normalise out scale.
      const ax = (i: number): V3 => {
        const v: V3 = [r[i * 4]!, r[i * 4 + 1]!, r[i * 4 + 2]!]
        const l = Math.hypot(v[0], v[1], v[2]) || 1
        return [v[0] / l, v[1] / l, v[2] / l]
      }
      const x = ax(0)
      const y = ax(1)
      const z = ax(2)
      rot = [x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]
    }
    const o: V3 = [
      rot[0] * offset[0] + rot[3] * offset[1] + rot[6] * offset[2],
      rot[1] * offset[0] + rot[4] * offset[1] + rot[7] * offset[2],
      rot[2] * offset[0] + rot[5] * offset[1] + rot[8] * offset[2],
    ]
    return { position: [w[12]! + o[0], w[13]! + o[1], w[14]! + o[2]], rotation: rot }
  }
}

export interface FxInstanceOptions extends FxSimulationOptions {
  /** Root pose source, sampled once per 20 Hz tick. Default: a fixed position. */
  pose?: () => FxRootPose
  position?: V3
  /** Interpolate positions between ticks (default true). */
  interpolate?: boolean
  /** Camera for billboards and pipes (default: scene.activeCamera). */
  camera?: Camera | null
}

const HALF = FX_PLATE_SIZE / 2
const PLATE_POS = [-HALF, HALF, 0, HALF, HALF, 0, HALF, -HALF, 0, -HALF, -HALF, 0]
const PLATE_UV = [0, 0, 1, 0, 1, 1, 0, 1]
/** Counter-clockwise seen from +Z (the plate's front in glTF space). */
const PLATE_IDX = [0, 3, 2, 0, 2, 1]

function stageFactor(op: FxStageOp): number {
  return op === 'texture' ? 0 : op === 'modulate2x' ? 2 : op === 'modulate4x' ? 4 : 1
}

type Kind = 'plate' | 'mesh' | 'pipe' | 'dpipe'

export class Batch {
  readonly mesh: Mesh
  capacity = 0
  positions = new Float32Array(0)
  colors = new Float32Array(0)
  uvs = new Float32Array(0)
  drawn = 0
  /** The last upload was of an empty batch (FxLibrary.skipEmptyUploads). */
  uploadedEmpty = false

  constructor(scene: Scene, name: string, material: StandardMaterial, readonly kind: Kind, readonly geometry: FxMeshData | null, readonly poolKey = '') {
    this.mesh = new Mesh(name, scene)
    this.mesh.material = material
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.hasVertexAlpha = true
    this.mesh.isVisible = false
  }

  get vertsPer(): number {
    return this.kind === 'mesh' ? this.geometry!.positions.length / 3 : this.kind === 'dpipe' ? 8 : 4
  }

  get indicesPer(): number {
    return this.kind === 'mesh' ? this.geometry!.indices.length : this.kind === 'dpipe' ? 12 : 6
  }

  ensure(count: number): void {
    if (count <= this.capacity) return
    let cap = Math.max(8, this.capacity)
    while (cap < count) cap *= 2
    this.capacity = cap
    const v = this.vertsPer * cap
    this.positions = new Float32Array(v * 3)
    this.colors = new Float32Array(v * 4)
    this.uvs = new Float32Array(v * 2)
    const idx = new Uint32Array(this.indicesPer * cap)
    const local = this.kind === 'mesh' ? this.geometry!.indices : this.kind === 'dpipe' ? [...PLATE_IDX, ...PLATE_IDX.map(i => i + 4)] : PLATE_IDX
    for (let e = 0; e < cap; e++) for (let k = 0; k < local.length; k++) idx[e * local.length + k] = local[k]! + e * this.vertsPer
    this.mesh.setVerticesData(VertexBuffer.PositionKind, this.positions, true, 3)
    this.mesh.setVerticesData(VertexBuffer.ColorKind, this.colors, true, 4)
    this.mesh.setVerticesData(VertexBuffer.UVKind, this.uvs, true, 2)
    this.mesh.setIndices(idx)
  }

  upload(): void {
    // nothing drawn now nor at the last upload: the buffers already hold zeros and the mesh is hidden
    if (this.drawn === 0 && this.uploadedEmpty && FxLibrary.skipEmptyUploads) return
    this.uploadedEmpty = this.drawn === 0
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions)
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.colors)
    this.mesh.updateVerticesData(VertexBuffer.UVKind, this.uvs)
    this.mesh.isVisible = this.drawn > 0
  }

  dispose(): void {
    this.mesh.dispose(false, false)
  }
}

export interface FxStats {
  ticks: number
  /** Live elements (all nodes). */
  elements: number
  /** Elements of drawing nodes. */
  visible: number
  /** Plates / meshes / pipe segments written this frame. */
  drawn: number
  batches: number
  finished: boolean
}

/** One playing effect. Call update(dt) every frame; dispose() when done. */
export class FxInstance {
  readonly sim: FxSimulation
  private batches: Array<Batch | null>
  private acc = 0
  private readonly pose: () => FxRootPose
  private readonly interpolate: boolean
  private readonly camera: Camera | null | undefined
  private disposed = false
  /** Opacity multiplier (0..1) of everything drawn: skilleffect fade-in/out (docs/EFFECTS.md M15). */
  fade = 1

  constructor(readonly library: FxLibrary, readonly effect: FxEffect, options: FxInstanceOptions = {}) {
    this.sim = new FxSimulation(effect, options)
    const fixed = options.position ?? [0, 0, 0]
    this.pose = options.pose ?? (() => ({ position: fixed }))
    this.interpolate = options.interpolate ?? true
    this.camera = options.camera
    const scene = library.scene
    this.batches = effect.nodes.map((node, i) => this.makeBatch(scene, node, i))
  }

  private makeBatch(scene: Scene, node: FxNode, i: number): Batch | null {
    if (node.render === 'none' || !node.material) return null
    const m = node.material
    let kind: Kind = node.render === 'mesh' ? 'mesh' : node.render === 'plate' ? 'plate' : node.render === 'dpipe' ? 'dpipe' : 'pipe'
    let geometry: FxMeshData | null = null
    if (kind === 'mesh') {
      geometry = m.mesh >= 0 ? this.library.meshGeometry(this.effect.meshes[m.mesh]!) : null
      if (!geometry || geometry.indices.length === 0) kind = 'plate'
    }
    const material = this.library.material(this.effect, m)
    const key = this.library.batchKey(material, kind, geometry)
    const name = `fx:${this.effect.key}#${i}:${node.name}`
    const pooled = this.library.takeBatch(key)
    if (pooled) {
      pooled.mesh.name = name
      return pooled
    }
    return new Batch(scene, name, material, kind, geometry, key)
  }

  get stats(): FxStats {
    return {
      ticks: this.sim.tick,
      elements: this.sim.liveCount,
      visible: this.sim.visibleCount,
      drawn: this.batches.reduce((n, b) => n + (b?.drawn ?? 0), 0),
      batches: this.batches.filter(b => b).length,
      finished: this.sim.finished,
    }
  }

  get finished(): boolean {
    return this.sim.finished
  }

  stop(): void {
    this.sim.stop()
  }

  restart(): void {
    this.sim.restart()
    this.acc = 0
  }

  /** Advances by dt seconds (fixed 20 Hz ticks, at most 10 per call) and rebuilds the geometry. */
  update(dt: number): void {
    if (this.disposed) return
    if (this.sim.tick === 0) this.sim.step(this.pose())
    this.acc += Math.max(0, dt)
    let steps = 0
    while (this.acc >= FxSimulation.TICK && steps < 10) {
      this.sim.step(this.pose())
      this.acc -= FxSimulation.TICK
      steps++
    }
    if (steps === 10) this.acc = 0
    this.render(this.interpolate ? this.acc / FxSimulation.TICK : 1)
  }

  dispose(): void {
    this.disposed = true
    for (const b of this.batches) if (b && !this.library.giveBatch(b)) b.dispose()
    this.batches = []
  }

  private render(frac: number): void {
    const camera = this.camera ?? this.library.scene.activeCamera
    let right: V3 = [1, 0, 0]
    let up: V3 = [0, 1, 0]
    let back: V3 = [0, 0, 1]
    let eye: V3 = [0, 0, 10]
    if (camera) {
      const w = camera.getWorldMatrix().m
      const norm = (v: V3): V3 => {
        const l = Math.hypot(v[0], v[1], v[2]) || 1
        return [v[0] / l, v[1] / l, v[2] / l]
      }
      right = norm([w[0]!, w[1]!, w[2]!])
      up = norm([w[4]!, w[5]!, w[6]!])
      back = cross(right, up)
      eye = [camera.globalPosition.x, camera.globalPosition.y, camera.globalPosition.z]
    }
    const s = this.sim.scale
    for (let n = 0; n < this.batches.length; n++) {
      const b = this.batches[n]
      if (!b) continue
      const node = this.effect.nodes[n]!
      const list = this.sim.elements[n]!
      const m = node.material!
      const cf = stageFactor(m.colorOp)
      const af = stageFactor(m.alphaOp)
      const at = (e: FxElement): V3 => {
        const t = this.interpolate ? frac : 1
        return [(e.prev[0] + (e.pos[0] - e.prev[0]) * t) * s, (e.prev[1] + (e.pos[1] - e.prev[1]) * t) * s, (e.prev[2] + (e.pos[2] - e.prev[2]) * t) * s]
      }
      // fade (0..1) scales alpha; ONE/ONE ignores alpha, so it scales the colour there.
      const fk = this.fade < 1 ? Math.max(0, this.fade) : 1
      const kc = m.blend === 'oneone' ? fk : 1
      const colorOf = (e: FxElement): [number, number, number, number] => [
        (cf ? e.color[0] * cf : 1) * kc,
        (cf ? e.color[1] * cf : 1) * kc,
        (cf ? e.color[2] * cf : 1) * kc,
        (af ? Math.min(1, e.color[3] * af) : 1) * fk,
      ]
      if (b.kind === 'pipe' || b.kind === 'dpipe') {
        this.renderPipes(b, list, at, colorOf, eye, s)
        continue
      }
      b.ensure(list.length)
      const vp = b.vertsPer
      const localPos = b.kind === 'mesh' ? b.geometry!.positions : PLATE_POS
      const localUv = b.kind === 'mesh' ? b.geometry!.uvs : PLATE_UV
      const ti = this.interpolate ? frac : 1
      let k = 0
      for (const e of list) {
        // G1 rescue: no array per element per frame (the arithmetic of `at` and `colorOf` and of the camera basis and the
        // element's linear map, written into scratch arrays: ≈ 0.8 MB of garbage a frame at the 20-player boss fight).
        const p = S_P
        p[0] = (e.prev[0] + (e.pos[0] - e.prev[0]) * ti) * s
        p[1] = (e.prev[1] + (e.pos[1] - e.prev[1]) * ti) * s
        p[2] = (e.prev[2] + (e.pos[2] - e.prev[2]) * ti) * s
        const basis = this.basisInto(node, e, p, right, up, back, eye, S_B)
        const l = linearInto(S_L, basis, e.shape, e.scale, s)
        const c = S_C
        c[0] = (cf ? e.color[0] * cf : 1) * kc
        c[1] = (cf ? e.color[1] * cf : 1) * kc
        c[2] = (cf ? e.color[2] * cf : 1) * kc
        c[3] = (af ? Math.min(1, e.color[3] * af) : 1) * fk
        const uv = e.uv
        const base = k * vp
        for (let v = 0; v < vp; v++) {
          const x = localPos[v * 3]!
          const y = localPos[v * 3 + 1]!
          const z = localPos[v * 3 + 2]!
          const o = (base + v) * 3
          b.positions[o] = p[0] + l[0] * x + l[3] * y + l[6] * z
          b.positions[o + 1] = p[1] + l[1] * x + l[4] * y + l[7] * z
          b.positions[o + 2] = p[2] + l[2] * x + l[5] * y + l[8] * z
          const ci = (base + v) * 4
          b.colors[ci] = c[0]
          b.colors[ci + 1] = c[1]
          b.colors[ci + 2] = c[2]
          b.colors[ci + 3] = c[3]
          const u = localUv[v * 2]!
          const w = localUv[v * 2 + 1]!
          b.uvs[(base + v) * 2] = uv ? uv[0] + u * uv[2] : u
          b.uvs[(base + v) * 2 + 1] = uv ? uv[1] + w * uv[3] : w
        }
        k++
      }
      b.positions.fill(0, k * vp * 3)
      b.colors.fill(0, k * vp * 4)
      b.drawn = k
      b.upload()
    }
  }

  /**
   * Orientation of an element's geometry: its own frame (returned as it is), or a camera-facing basis written into
   * `out` (G1 rescue: no allocation per element per frame).
   */
  private basisInto(node: FxNode, e: FxElement, p: V3, right: V3, up: V3, back: V3, eye: V3, out: M3): M3 {
    switch (node.view) {
      case 'billboard':
        out[0] = right[0]
        out[1] = right[1]
        out[2] = right[2]
        out[3] = up[0]
        out[4] = up[1]
        out[5] = up[2]
        out[6] = back[0]
        out[7] = back[1]
        out[8] = back[2]
        return out
      case 'ybillboard':
      case 'vbillboard': {
        let ax = 0
        let ay = 1
        let az = 0
        if (node.view === 'vbillboard') {
          const l = Math.hypot(e.orient[3], e.orient[4], e.orient[5])
          if (l > 1e-12) {
            ax = e.orient[3] / l
            ay = e.orient[4] / l
            az = e.orient[5] / l
          }
        }
        const tx = eye[0] - p[0]
        const ty = eye[1] - p[1]
        const tz = eye[2] - p[2]
        const d = tx * ax + ty * ay + tz * az
        let fx = tx - ax * d
        let fy = ty - ay * d
        let fz = tz - az * d
        if (Math.hypot(fx, fy, fz) < 1e-9) {
          fx = back[0]
          fy = back[1]
          fz = back[2]
        }
        const fl = Math.hypot(fx, fy, fz)
        if (fl > 1e-12) {
          fx /= fl
          fy /= fl
          fz /= fl
        } else {
          fx = 0
          fy = 1
          fz = 0
        }
        let rx = ay * fz - az * fy
        let ry = az * fx - ax * fz
        let rz = ax * fy - ay * fx
        const rl = Math.hypot(rx, ry, rz)
        if (rl > 1e-12) {
          rx /= rl
          ry /= rl
          rz /= rl
        } else {
          rx = 0
          ry = 1
          rz = 0
        }
        out[0] = rx
        out[1] = ry
        out[2] = rz
        out[3] = ax
        out[4] = ay
        out[5] = az
        out[6] = fx
        out[7] = fy
        out[8] = fz
        return out
      }
      default:
        return e.orient
    }
  }

  /** Camera-facing ribbon segments between consecutive members of each group (pipe: one strip, dpipe: two). */
  private renderPipes(b: Batch, list: FxElement[], at: (e: FxElement) => V3, colorOf: (e: FxElement) => [number, number, number, number],
    eye: V3, s: number): void {
    const groups = new Map<unknown, FxElement[]>()
    for (const e of list) {
      const key = e.group ?? e.parent
      let g = groups.get(key)
      if (!g) groups.set(key, (g = []))
      g.push(e)
    }
    let segments = 0
    for (const g of groups.values()) segments += Math.max(0, g.length - 1)
    b.ensure(segments)
    let k = 0
    const vp = b.vertsPer
    for (const g of groups.values()) {
      if (g.length < 2) continue
      g.sort((x, y) => x.serial - y.serial)
      const pts = g.map(at)
      for (let i = 0; i + 1 < g.length; i++) {
        const a = pts[i]!
        const c = pts[i + 1]!
        const tangent = normalize([c[0] - a[0], c[1] - a[1], c[2] - a[2]])
        const mid: V3 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2]
        const to = normalize([eye[0] - mid[0], eye[1] - mid[1], eye[2] - mid[2]])
        const side1 = normalize(cross(to, tangent))
        const sides = b.kind === 'dpipe' ? [side1, normalize(cross(tangent, side1))] : [side1]
        const ea = g[i]!
        const ec = g[i + 1]!
        const wa = ea.scale[0] * HALF * s
        const wc = ec.scale[0] * HALF * s
        const ca = colorOf(ea)
        const cc = colorOf(ec)
        const u0 = i / (g.length - 1)
        const u1 = (i + 1) / (g.length - 1)
        sides.forEach((side, strip) => {
          const base = k * vp + strip * 4
          // Quad corners in PLATE_POS order (TL, TR, BR, BL): a+side, c+side, c-side, a-side.
          const corners: Array<[V3, number, [number, number, number, number], number, number]> = [
            [a, wa, ca, u0, 0],
            [c, wc, cc, u1, 0],
            [c, -wc, cc, u1, 1],
            [a, -wa, ca, u0, 1],
          ]
          corners.forEach(([p, w, col, u, v], j) => {
            const o = (base + j) * 3
            b.positions[o] = p[0] + side[0] * w
            b.positions[o + 1] = p[1] + side[1] * w
            b.positions[o + 2] = p[2] + side[2] * w
            b.colors.set(col, (base + j) * 4)
            b.uvs[(base + j) * 2] = u
            b.uvs[(base + j) * 2 + 1] = v
          })
        })
        k++
      }
    }
    b.positions.fill(0, k * vp * 3)
    b.colors.fill(0, k * vp * 4)
    b.drawn = k
    b.upload()
  }
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2])
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0]
}

/** Scratch for FxInstance.render's plate and mesh loop (G1 rescue: no array per element per frame). */
const S_P: V3 = [0, 0, 0]
const S_C: [number, number, number, number] = [0, 0, 0, 0]
const S_B: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const S_L: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const S_T: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** basis * shape * diag(scale) * s, into `out` (no allocation; `out` must not be `basis` or `shape`). */
function linearInto(out: M3, basis: M3, shape: M3, scale: V3, s: number): M3 {
  const t = S_T
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) t[c * 3 + r] = basis[r]! * shape[c * 3]! + basis[3 + r]! * shape[c * 3 + 1]! + basis[6 + r]! * shape[c * 3 + 2]!
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 3 + r] = t[c * 3 + r]! * scale[c]! * s
  return out
}

