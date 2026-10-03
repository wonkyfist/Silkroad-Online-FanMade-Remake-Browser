/**
 * BT-M, the region batch on a streamed NullEngine world with real ObjectMaterials conversions (docs/BATCHING.md §3.1,
 * §3.7, §3.8, §4.5; docs/WAVE_PLAN6.md §6.1): the material mode draws exactly today's geometry with today's (untouched)
 * materials; the table mode merges the classes into one group per (LOD group, cut-out, sheen, lamp) on group materials
 * of its own, packs the slot into UV2 and emits two-sided pieces twice; separate and lamp materials take their groups;
 * foliage stays chunks; draw ranges follow the live scale; unload, the path switch and dispose leave no mesh, slot or
 * pin; a build dropped in flight lands nothing; the merge runs through a (structured-clone) worker and survives one
 * that fails.
 */
import {
  AssetContainer,
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
  VertexBuffer,
  type AbstractMesh,
  type BaseTexture,
  type Material,
} from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorldModel } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  RegionStreamer,
  STREAM_DEFAULTS,
  SHADOW_PROXY_LAYER,
  WORLD_OBJECT_LAYER,
  World,
  WorldRegions,
  loadNavStreamed,
  prepareStatic,
  type BatchCommitContext,
  type BatchWorkerLike,
  type CachedModel,
  type MaterialBatchRecord,
  type RegionBatch,
  type RegionListener,
  type RenderPath,
  type SidecarLite,
} from '../src/index.ts'
import { unpackUv2, MergeHost, type MergeRequest } from '../src/batch/merge-core.ts'
import { RegionBatchPart, classOf, tableKey, type BatchTableEntry, type BatchTables, type GroupMaterialKey } from '../src/batch/region-batch.ts'
import { createBatchPart, setBatchTables } from '../src/batch/index.ts'
import { SRO_SURFACE_PLUGIN } from '../src/pbr/surface-plugin.ts'
import { uvScrollPhase, uvScrollPluginOf } from '../src/uv-scroll.ts'
import { BASE_URL, CX, CZ, X0, makeFixture, settle, type Fixture } from './stream-fixture.ts'
import { LAMP_SOURCE, addModel, centre } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
  setBatchTables(null)
})

// ---- fixtures -----------------------------------------------------------------------------------------------------

/** One primitive of a fixture model: a box (or a plane) with its own retail material. */
interface Prim {
  name: string
  /** The retail texture path (its name picks the class: wall → stone, wood/fence → wood, cloth → cloth). */
  texture: string
  alpha?: 'OPAQUE' | 'MASK' | 'BLEND'
  twoSided?: boolean
  unlit?: boolean
  emissive?: boolean
  plane?: boolean
  size?: number
  /** Wave 12 (UV scroll): the sidecar's retail texture scroll. */
  uvScroll?: [number, number]
}

const WALL: Prim = { name: 'wall', texture: 'res\\bldg\\wall01.ddj' }
const WOOD: Prim = { name: 'beam', texture: 'res\\bldg\\wood01.ddj', size: 0.5 }
const FENCE: Prim = { name: 'fence', texture: 'res\\bldg\\fence01.ddj', alpha: 'MASK', twoSided: true, plane: true }
const CLOTH: Prim = { name: 'awning', texture: 'res\\bldg\\cloth01.ddj', size: 0.7 }
const GLASS: Prim = { name: 'glass', texture: 'res\\bldg\\glass01.ddj', alpha: 'BLEND', plane: true }
const GLOW: Prim = { name: 'glow', texture: 'res\\bldg\\glow01.ddj', unlit: true, size: 0.3 }
const TIGER: Prim = { name: 'tiger', texture: 'res\\bldg\\tiger01.ddj', emissive: true, size: 0.4 }
/** Wave 12: the dragon fountain's cut-out waterfall sheet (cj_wf_dr_01: MASK, two-sided, scrolls -2.78 V/s). */
const FALL: Prim = { name: 'CJ_WF_dr_01', texture: 'prim\\mtrl\\particle\\pokpo2.ddj', alpha: 'MASK', twoSided: true, plane: true, uvScroll: [0, -2.78] }

/** A table that hands out slots, counts references and records what it was asked. */
class FakeTables implements BatchTables {
  lamps: boolean
  readonly refs = new Map<MaterialBatchRecord, { entry: BatchTableEntry; n: number }>()
  readonly bound: Array<{ material: PBRMaterial; key: GroupMaterialKey }> = []
  readonly emissive = new Map<number, [number, number, number]>()
  readonly ready: ((entries: readonly BatchTableEntry[]) => Promise<void> | void) | undefined
  disposed = 0
  private next = 1

  constructor(opts: { lamps?: boolean; refuse?: (r: MaterialBatchRecord) => boolean; ready?: (e: readonly BatchTableEntry[]) => Promise<void> } = {}) {
    this.lamps = opts.lamps ?? true
    this.refuse = opts.refuse ?? (() => false)
    this.ready = opts.ready
  }

  private readonly refuse: (r: MaterialBatchRecord) => boolean

  acquire(record: MaterialBatchRecord): BatchTableEntry | null {
    if (this.refuse(record)) return null
    let e = this.refs.get(record)
    if (!e) {
      e = { entry: { slot: this.next++, layer: record.lightmap ? 5 : 0, scale: 0.5, offsetU: 0.5, offsetV: 0 }, n: 0 }
      this.refs.set(record, e)
    }
    e.n++
    return e.entry
  }

  release(entry: BatchTableEntry): void {
    for (const [r, e] of this.refs) {
      if (e.entry !== entry) continue
      if (--e.n <= 0) this.refs.delete(r)
      return
    }
    throw new Error(`release of an unknown slot ${entry.slot}`)
  }

  setEmissive(slot: number, r: number, g: number, b: number): void {
    this.emissive.set(slot, [r, g, b])
  }

  bindMaterial(material: PBRMaterial, key: Readonly<GroupMaterialKey>): void {
    this.bound.push({ material, key: { ...key } })
  }

  dispose(): void {
    this.disposed++
  }

  get live(): number {
    return this.refs.size
  }
}

/** A worker stand-in: the real handler behind two structured-clone boundaries, answered on a later task. */
class CloneWorker implements BatchWorkerLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null
  readonly host = new MergeHost()
  posted = 0
  terminated = false
  constructor(readonly failAfter = Infinity) {}
  postMessage(message: unknown): void {
    if (++this.posted > this.failAfter) throw new Error('worker gone')
    const copy = structuredClone(message) as MergeRequest
    setTimeout(() => {
      if (this.terminated) return
      const answer = this.host.handle(copy)
      if (answer) this.onmessage?.({ data: structuredClone(answer) })
    }, 0)
  }

  terminate(): void {
    this.terminated = true
  }
}

interface Setup {
  scene: Scene
  world: World
  stream: RegionStreamer
  fx: Fixture
  parts: RegionBatchPart[]
  run(focus?: { x: number; z: number }, frames?: number): Promise<void>
  dispose(): void
}

interface SetupOptions {
  render?: RenderPath
  /** 'none': no batching part at all (today's chunks); null: the material mode; a table: the table mode. */
  tables?: BatchTables | null | 'none'
  /** The primitives of each model (default: model 0 = a wall). */
  prims?: (model: WorldModel) => Prim[]
  edit?: (fx: Fixture) => void
  worker?: (() => BatchWorkerLike | null) | null
  workerCacheBytes?: number
}

/** Makes a model container like the glTF loader's: a rotated root node, one mesh per primitive, retail materials. */
function modelContainer(scene: Scene, model: WorldModel, prims: Prim[]): { container: AssetContainer; sidecar: SidecarLite } {
  const container = new AssetContainer(scene)
  const root = new TransformNode(`${model.glb}#root`, scene)
  root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), 0.3)
  root.position.set(0.25, 0, -0.5)
  scene.removeTransformNode(root)
  container.transformNodes.push(root)
  container.rootNodes.push(root)
  const sidecar: SidecarLite = { materials: [] }
  prims.forEach((p, i) => {
    const mesh = (p.plane
      ? MeshBuilder.CreatePlane(`${model.index}:${p.name}`, { size: p.size ?? 1 }, scene)
      : MeshBuilder.CreateBox(`${model.index}:${p.name}`, { size: p.size ?? 1 }, scene)) as Mesh
    scene.removeMesh(mesh)
    mesh.position.set(i * 0.5, 0.5 + i * 0.25, 0)
    mesh.parent = root
    const src = new PBRMaterial(p.name, scene)
    scene.removeMaterial(src)
    src.backFaceCulling = !p.twoSided
    if (p.alpha === 'MASK') src.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    if (p.alpha === 'BLEND') {
      src.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND
      src.alpha = 0.5
    }
    if (p.emissive) src.emissiveColor = new Color3(0.5, 0.2, 0)
    mesh.material = src
    container.meshes.push(mesh)
    container.materials.push(src)
    sidecar.materials!.push({ name: p.name, flags: p.unlit ? 0x8 : 0, diffuse: [], ambient: [], texture: p.texture, alphaMode: p.alpha ?? 'OPAQUE', ...(p.uvScroll ? { uvScroll: p.uvScroll } : {}) })
  })
  return { container, sidecar }
}

async function batchWorld(o: SetupOptions = {}): Promise<Setup> {
  const fx = makeFixture()
  o.edit?.(fx)
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const assets = new Assets(BASE_URL, fx.io)
  const nav = await loadNavStreamed(fx.manifest, assets)
  const parts: RegionBatchPart[] = []
  const tables = o.tables === undefined ? null : o.tables
  const world = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, {
    baseUrl: BASE_URL, minimap: false, render: o.render ?? 'pbr',
    parts: {
      batch: tables === 'none' ? null : host => {
        const p = new RegionBatchPart(host, { tables, worker: o.worker ?? null, workerCacheBytes: o.workerCacheBytes })
        parts.push(p)
        return p
      },
      life: null, ocean: null,
    },
  })
  await world.water.init(assets)
  const prims = o.prims ?? ((m: WorldModel) => (m.index === 0 ? [WALL] : [WALL]))
  const loadModel = async (model: WorldModel): Promise<CachedModel> => {
    const { container, sidecar } = modelContainer(scene, model, prims(model))
    const converted = await world.materials.convert(container, sidecar, false, { model: model.glb!, source: model.source, kind: model.kind === 'skinned' ? 'clone' : 'static' })
    return { model, container, converted, prep: model.kind === 'static' ? prepareStatic(container) : null }
  }
  const disposeModel = (e: CachedModel) => {
    if (e.converted) world.materials.release(e.converted)
    e.container.dispose()
  }
  const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium }, {
    now: () => 0, autoPump: false, objects: true, nav: nav.chunks, loadModel, disposeModel,
    atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true },
  })
  world.stream = stream
  stream.booting = false
  const run = async (focus = centre(CX, CZ), frames = 800) => {
    for (let i = 0; i < frames; i++) {
      stream.update(focus, null)
      await settle(2)
      const s = stream.stats
      if (!s.jobs && !s.fetching && s.ready + s.failed === s.resident && s.objectsReady === s.ready) {
        stream.update(focus, null)
        if (!stream.stats.jobs) return
      }
    }
  }
  let done = false
  const dispose = () => {
    if (done) return
    done = true
    world.dispose()
    scene.dispose()
    engine.dispose()
  }
  cleanups.push(dispose)
  return { scene, world, stream, fx, parts, run, dispose }
}

/** The batch meshes of the scene that are not disposed (group meshes and proxies). */
const batchMeshes = (scene: Scene) => scene.meshes.filter(m => m.name.startsWith('batch') && !m.isDisposed())

/** World-space vertices of a mesh (a thin-instance chunk: every instance), rounded, keyed by the material's name. */
function worldVertices(mesh: AbstractMesh): string[] {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!
  const nrm = mesh.getVerticesData(VertexBuffer.NormalKind)!
  const m = mesh as AbstractMesh & { _thinInstanceDataStorage?: { matrixData?: Float32Array | null }; thinInstanceCount?: number }
  const count = m.thinInstanceCount ?? 0
  const data = m._thinInstanceDataStorage?.matrixData
  const matsOf: Matrix[] = count > 0 && data ? Array.from({ length: count }, (_, k) => Matrix.FromArray(data, k * 16)) : [mesh.computeWorldMatrix(true)]
  const out: string[] = []
  const name = mesh.material?.name ?? '?'
  for (const w of matsOf) {
    const nm = Matrix.Invert(w).transpose()
    for (let v = 0; v < pos.length / 3; v++) {
      const p = Vector3.TransformCoordinates(Vector3.FromArray(pos, v * 3), w)
      const n = Vector3.TransformNormal(Vector3.FromArray(nrm, v * 3), nm).normalize()
      const r = (x: number) => (Math.round(x * 1000) / 1000 + 0).toFixed(3)
      out.push(`${name} ${r(p.x)} ${r(p.y)} ${r(p.z)} | ${r(n.x)} ${r(n.y)} ${r(n.z)}`)
    }
  }
  return out
}

/** The properties a batcher must never change on a converted material (§4.5 finding 3). */
function materialShape(m: Material): string {
  const p = m as PBRMaterial
  return JSON.stringify({
    name: m.name, bfc: m.backFaceCulling, side: m.sideOrientation, tm: m.transparencyMode, alpha: m.alpha, two: p.twoSidedLighting,
    cut: p.alphaCutOff, ua: p.useAlphaFromAlbedoTexture, di: p.directIntensity, e: p.emissiveColor?.asArray(), rough: p.roughness, metal: p.metallic,
    plugins: (m.pluginManager as unknown as { _plugins?: unknown[] } | null)?._plugins?.length ?? 0, unlit: p.unlit,
  })
}

// ---- tests --------------------------------------------------------------------------------------------------------

describe('the material mode (no table): today\'s geometry and materials, merged per region', () => {
  it('every static region merges; the vertices, normals and materials are exactly the chunks\'', async () => {
    const prims = (m: WorldModel) => (m.index === 0 ? [WALL, WOOD] : m.index === 2 ? [FENCE, CLOTH] : [WALL])
    const edit = (fx: Fixture) => {
      addModel(fx, 'res\\bldg\\china\\jangan\\house01.bsr')
      // A rotated placement (the normals must follow it) in every region.
      for (const p of fx.manifest.placements) if (p.models[0] === 2) p.rotation = Quaternion.RotationAxis(Vector3.Up(), 1.1).asArray() as [number, number, number, number]
    }
    const today = await batchWorld({ tables: 'none', prims, edit })
    await today.run()
    const chunks = today.world.objects.meshes().filter(m => (m as Mesh).thinInstanceCount > 0)
    expect(chunks.length).toBeGreaterThan(0)
    const want = chunks.flatMap(worldVertices).sort()

    const s = await batchWorld({ tables: null, prims, edit })
    await s.run()
    const part = s.parts[0]!
    expect(s.world.batch).toBe(part)
    expect(part.tableMode).toBe(false)
    expect(s.world.objects.stats.chunks).toBe(0)
    const regions = s.stream.stats.ready
    expect(part.stats.regions).toBe(regions)
    const meshes = part.meshes()
    expect(meshes.every(m => m.getTotalIndices() > 0)).toBe(true)
    expect(meshes.flatMap(worldVertices).sort()).toEqual(want)
    // One mesh per (region, material) at most: never more draws than today's chunks.
    expect(meshes.length).toBeLessThanOrEqual(chunks.length)
    expect(meshes.every(m => (m.layerMask & WORLD_OBJECT_LAYER) !== 0 && !m.isPickable)).toBe(true)
    // The converted materials themselves draw, unchanged.
    const converted = new Set(s.world.materials.materials)
    for (const m of meshes) expect(converted.has(m.material as PBRMaterial)).toBe(true)
    const shape = (w: World) => w.materials.materials.map(materialShape).sort()
    expect(shape(s.world)).toEqual(shape(today.world))
  })

  it('the listener contract: no batch mesh through placed; one batched per region with its proxy, casters and slots', async () => {
    const prims = (m: WorldModel) => (m.index === 0 ? [WALL, FENCE] : [WALL])
    const s = await batchWorld({ tables: null, prims })
    const placed: AbstractMesh[] = []
    const batched: RegionBatch[] = []
    const l: RegionListener = { placed: (_r, _m, _i, meshes) => placed.push(...meshes), removed: () => {}, batched: (_r, b) => batched.push(b) }
    s.world.objects.addRegionListener(l)
    await s.run()
    expect(batched.length).toBe(s.stream.stats.ready)
    const all = new Set(batched.flatMap(b => [...b.meshes, ...(b.shadowProxy ? [b.shadowProxy] : [])]))
    for (const m of placed) expect(all.has(m)).toBe(false)
    const b = batched[0]!
    expect(b.meshes).toHaveLength(2)
    // The proxy: the opaque wall only, shadow-only.
    expect(b.shadowProxy).not.toBeNull()
    expect(b.shadowProxy!.layerMask).toBe(SHADOW_PROXY_LAYER)
    expect(b.shadowProxy!.getTotalIndices() / 3).toBe(12)
    // The alpha-tested fence casts as a cut-out, with its own (converted) material's alpha test.
    expect(b.cutoutCasters).toHaveLength(1)
    expect(b.cutoutCasters[0]!.material!.name).toBe('fence')
    expect(b.slots.map(x => x.material.name).sort()).toEqual(['fence', 'wall'])
    expect(b.slots.every(x => x.slot < 0 && x.cls === 'merge')).toBe(true)
    expect(b.max.x).toBeGreaterThan(b.min.x)
    // World.meshes has the batch meshes (the shelter, light lists), never the proxy.
    const world = new Set(s.world.meshes())
    for (const m of b.meshes) expect(world.has(m)).toBe(true)
    expect(world.has(b.shadowProxy!)).toBe(false)
  })

  it('foliage models are not claimed (their wind needs the pivot: BT-T); the skinned clone stays', async () => {
    let tree = -1
    const s = await batchWorld({ tables: null, edit: fx => { tree = addModel(fx, 'res\\nature\\china\\jangan\\tree\\cj_tree01.bsr') } })
    await s.run()
    expect(tree).toBeGreaterThan(1)
    // The tree's chunks (one per region) and the clone stay today's; model 0 is batched.
    expect(s.world.objects.stats.chunks).toBe(s.stream.stats.ready)
    expect(s.world.objects.stats.clones).toBe(1)
    expect(s.parts[0]!.stats.refused).toBe(s.stream.stats.ready)
    expect(s.world.objects.meshes().filter(m => (m as Mesh).thinInstanceCount > 0).every(m => m.name.includes(`m${tree}`))).toBe(true)
  })
})

describe('the table mode: class groups on group materials of their own (§3.1–§3.4)', () => {
  it('stone and wood merge into one opaque group; the cut-out and the sheen groups are their own; UV2 carries the slot', async () => {
    const tables = new FakeTables()
    const prims = (m: WorldModel) => (m.index === 0 ? [WALL, WOOD] : m.index === 2 ? [FENCE, CLOTH] : [WALL])
    const s = await batchWorld({ tables, prims, edit: fx => { addModel(fx, 'res\\bldg\\china\\jangan\\house01.bsr') } })
    await s.run()
    const part = s.parts[0]!
    const regions = s.stream.stats.ready
    expect(part.tableMode).toBe(true)
    expect(part.stats.regions).toBe(regions)
    // 3 groups per region: opaque (wall + beam), cut-out (fence), sheen (awning).
    expect(part.stats.tableGroups).toBe(3 * regions)
    expect(part.stats.materialGroups).toBe(0)
    const meshes = part.meshes()
    expect(meshes).toHaveLength(3 * regions)
    const mats = new Set(meshes.map(m => m.material!))
    expect(mats.size).toBe(3)
    expect(tables.bound.map(b => `${b.key.cutout}/${b.key.sheen}/${b.key.lamp}`).sort()).toEqual(['false/false/false', 'false/true/false', 'true/false/false'])
    const converted = new Set<Material>(s.world.materials.materials)
    for (const m of mats) {
      expect(converted.has(m)).toBe(false)
      const pm = m as PBRMaterial
      expect(pm.backFaceCulling).toBe(true)
      expect(pm.pluginManager?.getPlugin(SRO_SURFACE_PLUGIN)).toBeTruthy()
      const key = tables.bound.find(b => b.material === pm)!.key
      expect(pm.needAlphaTesting()).toBe(key.cutout)
      expect(pm.sheen.isEnabled).toBe(false) // Medium: no sheen (applyClassExtras, High+)
    }
    // Every vertex's UV2 names a slot the table gave out; the wall and the beam share their group.
    const slots = new Set([...tables.refs.values()].map(e => e.entry.slot))
    expect(slots.size).toBe(4)
    for (const m of meshes) {
      const uv2 = m.getVerticesData(VertexBuffer.UV2Kind)!
      const seen = new Set<number>()
      for (let v = 0; v < uv2.length / 2; v++) {
        const d = unpackUv2(uv2[v * 2]!, uv2[v * 2 + 1]!)
        expect(slots.has(d.slot)).toBe(true)
        expect(d.layer).toBe(0)
        expect(d.u).toBeGreaterThanOrEqual(0.5)
        expect(d.u).toBeLessThanOrEqual(1)
        seen.add(d.slot)
      }
      const key = tables.bound.find(b => b.material === m.material)!.key
      expect(seen.size).toBe(!key.cutout && !key.sheen ? 2 : 1)
    }
    // The two-sided fence (one plane per region: 2 triangles) is emitted twice.
    const cut = meshes.find(m => tables.bound.find(b => b.material === m.material)!.key.cutout)!
    expect(cut.getTotalIndices() / 3).toBe(4)
    // Each region holds one reference per material.
    for (const e of tables.refs.values()) expect(e.n).toBe(regions)
    expect(part.stats.slots).toBe(4 * regions)
  })

  it('separate materials (blend, unlit) and a retail emissive draw in material groups; lamps in the lamp group, or a material group without one', async () => {
    const prims = (m: WorldModel) => (m.index === 0 ? [WALL, GLASS, GLOW, TIGER] : m.source === LAMP_SOURCE ? [WALL] : [WALL])
    const edit = (fx: Fixture) => { addModel(fx, LAMP_SOURCE, { regions: id => id === ((CZ << 8) | CX) }) }
    const tables = new FakeTables({ lamps: true })
    const s = await batchWorld({ tables, prims, edit })
    await s.run()
    const part = s.parts[0]!
    const owner = [...s.world.objects.regionBatches.keys()].find(o => s.world.objects.regionBatches.get(o)!.region === ((CZ << 8) | CX))!
    const b = s.world.objects.regionBatches.get(owner)!
    const names = b.meshes.map(m => m.material!.name).sort()
    expect(names).toEqual(['batch:opaque', 'batch:opaque+lamp', 'glass', 'glow', 'tiger'])
    // The tiger's self-light stays on its converted material (PbrSurfaces drives it from the ambient every frame).
    const tiger = b.slots.find(x => x.material.name === 'tiger')!
    expect([tiger.cls, tiger.slot < 0]).toEqual(['lamp', true])
    const lampSlot = b.slots.find(x => x.cls === 'lamp' && x.model.source === LAMP_SOURCE)!
    expect(lampSlot.slot).toBeGreaterThan(0)
    expect(b.slots.filter(x => x.cls === 'separate').map(x => x.material.name).sort()).toEqual(['glass', 'glow'])
    // NL's glow: a table slot writes texel 5; a material slot writes its converted material (as NL did per chunk).
    b.setEmissive(lampSlot.slot, 0.9, 0.5, 0.1)
    expect(tables.emissive.get(lampSlot.slot)).toEqual([0.9, 0.5, 0.1])
    const glass = b.slots.find(x => x.material.name === 'glass')!
    b.setEmissive(glass.slot, 0.1, 0.2, 0.3)
    expect((glass.material as PBRMaterial).emissiveColor.asArray()).toEqual([0.1, 0.2, 0.3])
    // The blended glass casts as a cut-out (ShadowProxies' rule for non-opaque chunks); the glow is opaque.
    expect(b.cutoutCasters.map(m => m.material!.name)).toEqual(['glass'])
    expect(part.stats.materialGroups).toBe(3 * s.stream.stats.ready)

    const noLamp = new FakeTables({ lamps: false })
    const t = await batchWorld({ tables: noLamp, prims, edit })
    await t.run()
    const tb = [...t.world.objects.regionBatches.values()].find(x => x.region === ((CZ << 8) | CX))!
    expect(tb.meshes.map(m => m.material!.name).sort()).toEqual(['batch:opaque', 'glass', 'glow', 'tiger', 'wall'])
    expect(tb.slots.find(x => x.cls === 'lamp' && x.model.source === LAMP_SOURCE)!.slot).toBeLessThan(0)
  })

  it('a slot the table refuses draws in a material group; classes and keys follow batchClass', async () => {
    const tables = new FakeTables({ refuse: r => r.name === 'beam' })
    const s = await batchWorld({ tables, prims: m => (m.index === 0 ? [WALL, WOOD] : [WALL]) })
    await s.run()
    const b = [...s.world.objects.regionBatches.values()][0]!
    expect(b.meshes.map(m => m.material!.name).sort()).toEqual(['batch:opaque', 'beam'])
    const rec = s.world.materials.batchRecord(b.slots.find(x => x.material.name === 'wall')!.material)!
    expect(classOf(rec)).toBe('merge')
    expect(tableKey(rec, 'merge')).toEqual({ cutout: false, sheen: false, lamp: false })
    // A material named like a light is a lamp even without NL's night index (never merged dark, F9).
    expect(classOf({ ...rec, name: 'window_light' })).toBe('lamp')
    expect(tableKey({ ...rec, alpha: 'mask', cls: 'cloth' }, 'lamp')).toEqual({ cutout: true, sheen: true, lamp: true })
  })

  it('UV scroll: a scrolling cut-out stays out of the table in a material group on its converted material (the plugin runs), casts nothing, keeps its UVs', async () => {
    const tables = new FakeTables()
    const s = await batchWorld({ tables, prims: m => (m.index === 0 ? [WALL, FALL] : [WALL]) })
    await s.run()
    const part = s.parts[0]!
    const owner = [...s.world.objects.regionBatches.keys()].find(o => s.world.objects.regionBatches.get(o)!.meshes.some(m => m.material!.name === 'CJ_WF_dr_01'))!
    const b = s.world.objects.regionBatches.get(owner)!
    expect(b.meshes.map(m => m.material!.name).sort()).toEqual(['CJ_WF_dr_01', 'batch:opaque'])
    const slot = b.slots.find(x => x.material.name === 'CJ_WF_dr_01')!
    expect([slot.cls, slot.slot < 0]).toEqual(['separate', true])
    expect([...tables.refs.keys()].map(r => r.name)).toEqual(['wall'])
    // The group draws the converted material itself, which carries the scroll plugin (one clock for all of them).
    const sheet = b.meshes.find(m => m.material!.name === 'CJ_WF_dr_01')!
    expect(s.world.materials.materials).toContain(sheet.material)
    const plugin = uvScrollPluginOf(sheet.material)!
    expect([plugin.u, plugin.v, plugin.shared === s.world.materials.uvScroll]).toEqual([0, -2.78, true])
    // No cut-out caster for it (the shadow pass would alpha-test a still mask).
    expect(b.cutoutCasters).toEqual([])
    // The merged sheet keeps the source's UVs (the plugin adds the offset in the vertex shader).
    const uv = sheet.getVerticesData(VertexBuffer.UVKind)!
    const src = MeshBuilder.CreatePlane('ref', { size: 1 }, s.scene).getVerticesData(VertexBuffer.UVKind)!
    expect(Array.from(uv.slice(0, src.length))).toEqual(Array.from(src))
    expect(part.stats.materialGroups).toBeGreaterThan(0)
    // The offset follows the world clock (setClock's serverNow).
    s.world.setClock(null, () => 1_000_250)
    s.world.materials.uvScroll.tick()
    expect(plugin.offset()[1]).toBeCloseTo(uvScrollPhase(-2.78, 1000.25), 12)
  })

  it('the batch shows once the table says its cells are in', async () => {
    let open: () => void = () => {}
    const gate = new Promise<void>(r => { open = r })
    const tables = new FakeTables({ ready: () => gate })
    const s = await batchWorld({ tables })
    for (let i = 0; i < 300; i++) {
      s.stream.update(centre(CX, CZ), null)
      await settle(2)
    }
    expect(s.stream.stats.ready).toBeGreaterThan(0)
    expect(s.stream.stats.objectsReady).toBe(0)
    expect(s.parts[0]!.stats.pending).toBe(s.stream.stats.ready)
    open()
    await s.run()
    expect(s.stream.stats.objectsReady).toBe(s.stream.stats.ready)
    expect(s.parts[0]!.stats.pending).toBe(0)
  })
})

describe('draw ranges (§3.8, F11)', () => {
  it('group 2 per region at 202 m × scale; group 3 in 96 m sub-chunks at 48 m × scale; the scale and the toggle are live', async () => {
    let props = -1
    const edit = (fx: Fixture) => {
      props = addModel(fx, 'res\\bldg\\china\\jangan\\lion01.bsr', { regions: id => id === ((CZ << 8) | CX) })
      const r = fx.manifest.regions.find(x => x.id === ((CZ << 8) | CX))!
      const p = fx.manifest.placements.find(x => x.models[0] === props)!
      p.group = 3
      // A second prop in the region's north-east sub-chunk.
      fx.manifest.placements.push({ ...p, uid: fx.manifest.placements.length, position: [r.origin[0] + 150, p.position[1], r.origin[2] - 150] })
    }
    const s = await batchWorld({ tables: new FakeTables(), edit })
    await s.run()
    const part = s.parts[0]!
    const b = [...s.world.objects.regionBatches.values()].find(x => x.region === ((CZ << 8) | CX))!
    // The wall (group 2) and two group-3 sub-chunks.
    expect(b.meshes).toHaveLength(3)
    const g2 = b.meshes.find(m => m.name.includes(':2:'))!
    const g3 = b.meshes.filter(m => m.name.includes(':3:'))
    expect(g3).toHaveLength(2)
    const sphere = (m: AbstractMesh) => {
      const bb = m.getBoundingInfo().boundingBox
      return { c: bb.minimumWorld.add(bb.maximumWorld).scale(0.5), r: bb.maximumWorld.subtract(bb.minimumWorld).length() / 2 }
    }
    const at = (m: AbstractMesh, surfaceDistance: number) => {
      const sp = sphere(m)
      return sp.c.add(new Vector3(0, 0, sp.r + surfaceDistance))
    }
    part.update(at(g2, 150))
    expect(g2.isEnabled(false)).toBe(true)
    part.update(at(g2, 210))
    expect(g2.isEnabled(false)).toBe(false)
    s.world.objects.setRangeScale(1.4)
    expect(g2.isEnabled(false)).toBe(true)
    s.world.objects.setRangeScale(0.6)
    part.update(at(g2, 150))
    expect(g2.isEnabled(false)).toBe(false)
    s.world.objects.setRangeScale(1)
    part.update(at(g3[0]!, 40))
    expect(g3[0]!.isEnabled(false)).toBe(true)
    part.update(at(g3[0]!, 55))
    expect(g3[0]!.isEnabled(false)).toBe(false)
    part.update(at(g2, 10))
    expect(g2.isEnabled(false)).toBe(true)
    s.world.objects.setStaticVisible(false)
    expect(b.meshes.every(m => !m.isEnabled(false))).toBe(true)
    s.world.objects.setStaticVisible(true)
    expect(g2.isEnabled(false)).toBe(true)
    // The proxy is never range-culled (the CSM's caster list chooses it).
    expect(b.shadowProxy!.isEnabled(false)).toBe(true)
  })
})

describe('lifetime: unload, the path switch, dispose and builds in flight', () => {
  it('unloading frees every mesh, slot and pin; a region loaded again builds again', async () => {
    const tables = new FakeTables()
    const s = await batchWorld({ tables, prims: m => (m.index === 0 ? [WALL, FENCE] : [WALL]) })
    await s.run()
    const part = s.parts[0]!
    expect(tables.live).toBe(2)
    await s.run({ x: 50_000, z: 50_000 })
    expect(s.stream.stats.resident).toBe(0)
    expect(batchMeshes(s.scene)).toEqual([])
    for (const k of ['regions', 'meshes', 'groups', 'tableGroups', 'materialGroups', 'slots', 'triangles', 'vertices', 'bytes', 'proxies', 'pending']) {
      expect(part.stats[k], k).toBe(0)
    }
    expect(tables.live).toBe(0)
    await s.run()
    expect(part.stats.regions).toBe(s.stream.stats.ready)
    expect(tables.live).toBe(2)
    // Walking west: the east regions go, their batches with them; nothing else stays.
    await s.run({ x: centre(X0, CZ).x - 600, z: centre(X0, CZ).z })
    expect(part.stats.regions).toBe(s.world.objects.regionBatches.size)
    expect(batchMeshes(s.scene).length).toBe(part.stats.meshes + part.stats.proxies)
  })

  it('PBR → Classic → PBR releases everything (chunks on Classic) and claims again; dispose frees the group materials', async () => {
    const tables = new FakeTables()
    const s = await batchWorld({ tables })
    await s.run()
    const first = s.parts[0]!
    const groupMats = new Set(first.meshes().map(m => m.material!))
    s.world.setRenderMode('classic')
    expect(s.world.batch).toBeNull()
    expect(batchMeshes(s.scene)).toEqual([])
    expect(tables.live).toBe(0)
    for (const m of groupMats) expect(s.scene.materials.includes(m)).toBe(false)
    expect(tables.disposed).toBe(1)
    await s.run()
    expect(s.world.objects.stats.chunks).toBe(s.stream.stats.ready)
    s.world.setRenderMode('pbr')
    const second = s.parts[1]!
    await s.run()
    expect(s.world.batch).toBe(second)
    expect(second.stats.regions).toBe(s.stream.stats.ready)
    expect(s.world.objects.stats.chunks).toBe(0)
  })

  it('removeRegion drops a build in flight (it resolves null and lands nothing) and is idempotent', async () => {
    const s = await batchWorld({ tables: new FakeTables() })
    await s.run()
    const part = s.parts[0]!
    const src = [...s.world.objects.regionBatches.values()][0]!
    // A fresh claim on a made-up owner, with a hand-run job queue.
    const model = s.fx.manifest.models[0]!
    const cached = (s.stream as unknown as { models: { peek(i: number): CachedModel | null } }).models.peek(0)!
    const owner = 9_999
    const placements = s.fx.manifest.placements.filter(p => p.models[0] === 0).slice(0, 2)
    expect(part.claim(owner, { model, entry: cached, prep: cached.prep! }, placements)).toHaveLength(2)
    const jobs: Array<() => void> = []
    let alive = true
    const ctx: BatchCommitContext = { schedule: run => jobs.push(run), alive: () => alive }
    const region = { owner, id: src.region, x: CX, z: CZ, origin: [0, 0, 0] as const }
    const built = Promise.resolve(part.commit(region, ctx))
    jobs.shift()!() // the geometry job
    expect(part.stats.pending).toBe(1)
    part.removeRegion(owner)
    part.removeRegion(owner)
    alive = false
    for (let i = 0; i < 20 && jobs.length; i++) jobs.shift()!()
    expect(await built).toBeNull()
    expect(part.stats.pending).toBe(0)
    expect(batchMeshes(s.scene).filter(m => m.name.includes(`:${owner}:`) || m.name.endsWith(`:${owner}`))).toEqual([])

    // Dropped after the merge, between two mesh jobs: the meshes made so far go.
    expect(part.claim(owner + 1, { model, entry: cached, prep: cached.prep! }, placements)).toHaveLength(2)
    const jobs2: Array<() => void> = []
    const ctx2: BatchCommitContext = { schedule: run => jobs2.push(run), alive: () => true }
    const built2 = Promise.resolve(part.commit({ ...region, owner: owner + 1 }, ctx2))
    for (let i = 0; i < 50; i++) {
      while (jobs2.length) {
        jobs2.shift()!()
        if (batchMeshes(s.scene).some(m => m.name.startsWith(`batch:${owner + 1}:`))) break
      }
      if (batchMeshes(s.scene).some(m => m.name.startsWith(`batch:${owner + 1}:`))) break
      await settle(1)
    }
    expect(batchMeshes(s.scene).some(m => m.name.startsWith(`batch:${owner + 1}:`))).toBe(true)
    part.removeRegion(owner + 1)
    expect(await built2).toBeNull()
    expect(batchMeshes(s.scene).filter(m => m.name.startsWith(`batch:${owner + 1}:`) || m.name === `batchProxy:${owner + 1}`)).toEqual([])
    // Unknown owners are fine too.
    part.removeRegion(123_456)
  })
})

describe('the merge worker', () => {
  it('regions build through a structured-clone worker, with the same result as in-process', async () => {
    const workers: CloneWorker[] = []
    const s = await batchWorld({ tables: new FakeTables(), worker: () => { const w = new CloneWorker(); workers.push(w); return w } })
    await s.run()
    const part = s.parts[0]!
    expect(part.stats.worker).toBe(1)
    expect(part.stats.regions).toBe(s.stream.stats.ready)
    expect(workers[0]!.host.models.size).toBeGreaterThan(0)
    const local = await batchWorld({ tables: new FakeTables() })
    await local.run()
    const tris = (p: RegionBatchPart) => p.stats.triangles
    expect(tris(part)).toBe(tris(local.parts[0]!))
    expect(part.meshes().flatMap(worldVertices).sort()).toEqual(local.parts[0]!.meshes().flatMap(worldVertices).sort())
  })

  it('a worker that fails hands its merges to the main thread; a tiny cache drops models and sends them again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = new CloneWorker(3)
    const s = await batchWorld({ tables: new FakeTables(), worker: () => failing })
    await s.run()
    expect(s.parts[0]!.stats.worker).toBe(0)
    expect(s.parts[0]!.stats.regions).toBe(s.stream.stats.ready)
    expect(failing.terminated).toBe(true)
    expect(warn).toHaveBeenCalled()

    const w = new CloneWorker()
    const t = await batchWorld({ tables: new FakeTables(), worker: () => w, workerCacheBytes: 1, prims: m => (m.index === 0 ? [WALL, WOOD] : [WALL]) })
    await t.run()
    expect(t.parts[0]!.stats.regions).toBe(t.stream.stats.ready)
    expect(w.host.models.size).toBe(0)
    await t.run({ x: 50_000, z: 50_000 })
    await t.run()
    expect(t.parts[0]!.stats.regions).toBe(t.stream.stats.ready)
  })
})

describe('createBatchPart (batch/index.ts)', () => {
  it('no table wired: no part (today\'s chunks); a table: the table mode on PBR only', async () => {
    const s = await batchWorld({ tables: 'none' })
    const host = { world: s.world, scene: s.scene, objects: s.world.objects, materials: s.world.materials, path: 'pbr' as const, models: s.fx.manifest.models, worker: null }
    setBatchTables(null)
    expect(createBatchPart(host)).toBeNull()
    const tables = new FakeTables()
    setBatchTables(() => tables)
    const part = createBatchPart(host)
    expect(part).toBeInstanceOf(RegionBatchPart)
    expect((part as RegionBatchPart).tableMode).toBe(true)
    part!.dispose()
    expect(tables.disposed).toBe(1)
    expect(createBatchPart({ ...host, path: 'classic' })).toBeNull()
    setBatchTables(() => null)
    expect(createBatchPart(host)).toBeNull()
  })

  it('the default world wires it: with a table wired, a streamed PBR world batches; Classic never', async () => {
    setBatchTables(() => new FakeTables())
    const fx = makeFixture()
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => engine.dispose())
    const assets = new Assets(BASE_URL, fx.io)
    const nav = await loadNavStreamed(fx.manifest, assets)
    for (const render of ['pbr', 'classic'] as const) {
      const w = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, { baseUrl: BASE_URL, minimap: false, render })
      const stream = new RegionStreamer(w, { ...STREAM_DEFAULTS.medium }, { now: () => 0, autoPump: false, objects: true, nav: nav.chunks, atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true } })
      w.stream = stream
      expect(!!w.batch).toBe(render === 'pbr')
      if (w.batch) expect(w.batch).toBeInstanceOf(RegionBatchPart)
      w.dispose()
    }
  })
})
