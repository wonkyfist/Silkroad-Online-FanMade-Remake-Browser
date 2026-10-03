/**
 * W12-SA's fixture (docs/WAVE_PLAN8.md §4.2): the stream fixture (7 × 7 flat regions, a wall per region, a skinned prop
 * in the centre) plus BT-T's trees (a skinned maple with a static variant, a static pine, each at its own spot in every
 * region), on a NullEngine World with real ObjectMaterials conversions, a fake material table and the in-process merge,
 * driven by a streamer whose frame budget never runs out. Shared by trees12-seams, scale-seam and reload-objects.
 */
import {
  AssetContainer,
  Mesh,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Scene,
  TransformNode,
  type AbstractMesh,
  type BaseTexture,
} from '@babylonjs/core'
import type { WorldModel } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  RegionStreamer,
  STREAM_DEFAULTS,
  World,
  WorldRegions,
  loadNavStreamed,
  prepareStatic,
  type BatchHost,
  type CachedModel,
  type LoadWorldOptions,
  type MaterialBatchRecord,
  type RenderPath,
  type SidecarLite,
  type WorldParts,
} from '../src/index.ts'
import { RegionBatchPart, type BatchTableEntry, type BatchTables, type GroupMaterialKey } from '../src/batch/region-batch.ts'
import type { TreeMode } from '../src/batch/trees.ts'
import { BASE_URL, CX, CZ, makeFixture, settle, type Fixture } from './stream-fixture.ts'
import { addModel, centre } from './w10-fixture.ts'

export interface Prim {
  name: string
  texture: string
  alpha?: 'OPAQUE' | 'MASK'
  twoSided?: boolean
  plane?: boolean
  size?: number
}

/** A leaf card (alpha-tested, two-sided: foliage), a trunk (opaque bark: wood), a wall (a building). */
export const LEAF: Prim = { name: 'leaf', texture: 'res\\nature\\common\\tree\\tre_maple_leaf.ddj', alpha: 'MASK', twoSided: true, plane: true, size: 2 }
export const BARK: Prim = { name: 'bark', texture: 'res\\nature\\common\\tree\\tre_maple_bark.ddj', size: 0.6 }
export const WALL: Prim = { name: 'wall', texture: 'res\\bldg\\wall01.ddj' }

export const TREE_SKINNED = 'res\\nature\\common\\tree\\tre_maple01.bsr'
export const TREE_STATIC = 'res\\nature\\common\\tree\\tre_pine03.bsr'

/** A table that hands out slots, counts references and records the materials it bound (batch-trees.test.ts'). */
export class FakeTables implements BatchTables {
  readonly lamps = true
  readonly refs = new Map<MaterialBatchRecord, { entry: BatchTableEntry; n: number }>()
  readonly bound: Array<{ material: PBRMaterial; key: GroupMaterialKey }> = []
  private next = 1

  acquire(record: MaterialBatchRecord): BatchTableEntry | null {
    let e = this.refs.get(record)
    if (!e) {
      e = { entry: { slot: this.next++, layer: 0, scale: 0.5, offsetU: 0.5, offsetV: 0 }, n: 0 }
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

  setEmissive(): void {}

  bindMaterial(material: PBRMaterial, key: Readonly<GroupMaterialKey>): void {
    this.bound.push({ material, key: { ...key } })
  }

  get live(): number {
    return this.refs.size
  }
}

function modelContainer(scene: Scene, model: WorldModel, prims: Prim[]): { container: AssetContainer; sidecar: SidecarLite } {
  const container = new AssetContainer(scene)
  const root = new TransformNode(`${model.glb}#root`, scene)
  scene.removeTransformNode(root)
  container.transformNodes.push(root)
  container.rootNodes.push(root)
  const sidecar: SidecarLite = { materials: [] }
  prims.forEach((p, i) => {
    const mesh = (p.plane
      ? MeshBuilder.CreatePlane(`${model.index}:${p.name}`, { size: p.size ?? 1 }, scene)
      : MeshBuilder.CreateBox(`${model.index}:${p.name}`, { size: p.size ?? 1 }, scene)) as Mesh
    scene.removeMesh(mesh)
    mesh.position.set(0, 0.5 + i * 1.5, 0)
    mesh.parent = root
    const src = new PBRMaterial(p.name, scene)
    scene.removeMaterial(src)
    src.backFaceCulling = !p.twoSided
    if (p.alpha === 'MASK') src.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    mesh.material = src
    container.meshes.push(mesh)
    container.materials.push(src)
    sidecar.materials!.push({ name: p.name, flags: 0, diffuse: [], ambient: [], texture: p.texture, alphaMode: p.alpha ?? 'OPAQUE' })
  })
  return { container, sidecar }
}

export interface ObjectWorld {
  engine: NullEngine
  scene: Scene
  world: World
  stream: RegionStreamer
  fx: Fixture
  parts: RegionBatchPart[]
  /** Every BatchHost World handed to the batch factory (in order). */
  hosts: BatchHost[]
  /** Model indices loaded (in load order). */
  loads: number[]
  /** The skinned tree, its static variant, the static tree. */
  ids: { skinned: number; variant: number; pine: number }
  /** Pumps the streamer around the centre until nothing is left to do. */
  run(): Promise<void>
  dispose(): void
}

export interface ObjectWorldOptions {
  render?: RenderPath
  /** The table (default a FakeTables; null: the material mode). */
  tables?: BatchTables | null
  mode?: TreeMode
  trees?: LoadWorldOptions['trees']
  regionFilter?: LoadWorldOptions['regionFilter']
  /** Extra parts (trees, ...); the batch factory is the fixture's. */
  parts?: Partial<WorldParts>
  /** Changes the manifest before the world is made. */
  edit?: (fx: Fixture, ids: ObjectWorld['ids']) => void
  /** The batch part gets a host without the `treeSwap` field (a wave-10 host). */
  wave10Host?: boolean
  /** Keep the merged groups' CPU arrays (tests that read them back; H-12 MM1 frees the tree groups' otherwise). */
  keepCpuCopies?: boolean
}

/** The stream fixture plus BT-T's trees on a NullEngine World (see the file comment). */
export async function objectWorld(o: ObjectWorldOptions = {}): Promise<ObjectWorld> {
  const fx = makeFixture()
  const ids = { skinned: -1, variant: -1, pine: -1 }
  ids.skinned = addModel(fx, TREE_SKINNED, { kind: 'skinned' })
  ids.pine = addModel(fx, TREE_STATIC)
  const models = fx.manifest.models
  ids.variant = models.length
  models.push({ ...models[ids.skinned]!, index: ids.variant, kind: 'static', source: `${TREE_SKINNED}#static`, glb: `models/m${ids.variant}.static.glb` })
  models[ids.skinned]!.staticVariant = ids.variant
  // Every tree at its own spot (addModel puts every model at the same one).
  for (const p of fx.manifest.placements) {
    if (p.models[0] === ids.skinned) p.position = [p.position[0] + 12, p.position[1], p.position[2] - 7]
    if (p.models[0] === ids.pine) p.position = [p.position[0] - 9, p.position[1] + 1, p.position[2] + 15]
  }
  o.edit?.(fx, ids)
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const assets = new Assets(BASE_URL, fx.io)
  const nav = await loadNavStreamed(fx.manifest, assets)
  const parts: RegionBatchPart[] = []
  const hosts: BatchHost[] = []
  const tables = o.tables === undefined ? new FakeTables() : o.tables
  const world = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, {
    baseUrl: BASE_URL, minimap: false, render: o.render ?? 'pbr',
    ...(o.trees ? { trees: o.trees } : {}),
    ...(o.regionFilter !== undefined ? { regionFilter: o.regionFilter } : {}),
    parts: {
      batch: host => {
        hosts.push(host)
        let use: BatchHost = host
        if (o.wave10Host) {
          const { treeSwap: _drop, ...wave10 } = host
          use = wave10
        }
        const p = new RegionBatchPart(use, { tables, worker: null, trees: o.mode ? { mode: o.mode } : undefined, keepCpuCopies: o.keepCpuCopies })
        parts.push(p)
        return p
      },
      life: null, ocean: null, town: null,
      ...o.parts,
    },
  })
  await world.water.init(assets)
  const loads: number[] = []
  const prims = (m: WorldModel): Prim[] => (m.index === ids.variant || m.index === ids.skinned ? [LEAF, BARK] : m.index === ids.pine ? [BARK, LEAF] : [WALL])
  const loadModel = async (model: WorldModel): Promise<CachedModel> => {
    loads.push(model.index)
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
  const run = async () => {
    const focus = centre(CX, CZ)
    for (let i = 0; i < 800; i++) {
      stream.update(focus, null)
      await settle(2)
      const s = stream.stats
      if (!s.jobs && !s.fetching && s.ready + s.failed === s.resident && s.objectsReady === s.ready) {
        stream.update(focus, null)
        if (!stream.stats.jobs) return
      }
    }
  }
  const dispose = () => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  }
  return { engine, scene, world, stream, fx, parts, hosts, loads, ids, run, dispose }
}

/** Pumps the streamer around the centre until `p` settles (at most `max` updates); returns its value and the updates. */
export async function pumpUntil<T>(w: ObjectWorld, p: Promise<T>, max = 400): Promise<{ value: T; updates: number }> {
  let done = false
  let value: T | undefined
  void p.then(v => {
    done = true
    value = v
  })
  const focus = centre(CX, CZ)
  for (let i = 0; i < max; i++) {
    await settle(2)
    if (done) return { value: value as T, updates: i }
    w.stream.update(focus, null)
  }
  throw new Error('pumpUntil: did not settle')
}

export const isTreeMesh = (m: { metadata?: unknown }) => !!(m.metadata as { sroTree?: boolean } | null)?.sroTree

/** Every region batch's meshes keyed by (region id, group label): their vertex data, for byte comparisons. */
export function batchBytes(world: World): Map<string, Record<string, number[]>> {
  const out = new Map<string, Record<string, number[]>>()
  for (const batch of world.objects.regionBatches.values()) {
    for (const m of batch.meshes as AbstractMesh[]) {
      const label = m.name.split(':').slice(2).join(':')
      const data: Record<string, number[]> = {}
      for (const kind of (m as Mesh).getVerticesDataKinds()) data[kind] = [...((m as Mesh).getVerticesData(kind) ?? [])]
      data.indices = [...((m as Mesh).getIndices() ?? [])]
      out.set(`${batch.region}|${label}`, data)
    }
  }
  return out
}

export { CX, CZ, centre }
