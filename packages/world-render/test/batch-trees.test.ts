/**
 * BT-T, the trees of the region batch (docs/BATCHING.md §3.3, §3.5; docs/WAVE_PLAN6.md §6.1 BT-T, D30, D33) on a
 * streamed NullEngine world with real ObjectMaterials conversions:
 * - skinned foliage loads its static variant on Medium+ (the skinned glb is never fetched, no clone is made); Low and
 *   the material mode load nothing new;
 * - a region's trees merge into ≤ 2 tree draws (cut-out leaves, opaque wood) on two world-wide tree materials (table +
 *   foliage plugin with the pivot and the minimum breeze), and every merged vertex carries its own tree's root;
 * - the per-model instancing fallback holds one world-wide set per (model, primitive), culls by range, is never drawn at
 *   count 0, and gives the converted materials their breeze back on release;
 * - turning batching off leaves no tree mesh, slot or set.
 */
import {
  AssetContainer,
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
  type BaseTexture,
  type MaterialDefines,
} from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  RENDER_PRESETS,
  RegionStreamer,
  STREAM_DEFAULTS,
  StubTrees,
  World,
  WorldRegions,
  loadNavStreamed,
  prepareStatic,
  type CachedModel,
  type MaterialBatchRecord,
  type RenderPath,
  type RenderQuality,
  type SidecarLite,
  type TreesFactory,
  type TreesHost,
} from '../src/index.ts'
import { casterPrefixOf, mergeRegion, unpackUv2, type MergeGroupJob, type MergePrimitive } from '../src/batch/merge-core.ts'
import { CASTER_DROP_MARGIN_M } from '../src/render/shadows.ts'
import { RegionBatchPart, type BatchTableEntry, type BatchTables, type GroupMaterialKey } from '../src/batch/region-batch.ts'
import {
  TREE_BREEZE,
  TreeInstances,
  bandOfWord,
  bandWord,
  foldSwap,
  foliageKindOf,
  staticVariantOf,
  treeKeyOf,
  treeKeyName,
  type TreeMode,
} from '../src/batch/trees.ts'
import { FOLIAGE_PIVOT_KIND, FOLIAGE_TREEW_KIND, FoliageShared, SroFoliagePlugin, foliagePluginOf } from '../src/pbr/foliage-plugin.ts'
import { placementKey } from '../src/trees/types.ts'
import { BASE_URL, CX, CZ, makeFixture, settle, type Fixture } from './stream-fixture.ts'
import { addModel, centre } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

// ---- fixtures -----------------------------------------------------------------------------------------------------

interface Prim {
  name: string
  texture: string
  alpha?: 'OPAQUE' | 'MASK'
  twoSided?: boolean
  plane?: boolean
  size?: number
}

/** A leaf card (alpha-tested, two-sided: foliage) and a trunk (opaque bark: wood). */
const LEAF: Prim = { name: 'leaf', texture: 'res\\nature\\common\\tree\\tre_maple_leaf.ddj', alpha: 'MASK', twoSided: true, plane: true, size: 2 }
const BARK: Prim = { name: 'bark', texture: 'res\\nature\\common\\tree\\tre_maple_bark.ddj', size: 0.6 }
const WALL: Prim = { name: 'wall', texture: 'res\\bldg\\wall01.ddj' }

const TREE_SKINNED = 'res\\nature\\common\\tree\\tre_maple01.bsr'
const TREE_STATIC = 'res\\nature\\common\\tree\\tre_pine03.bsr'

/** A table that hands out slots, counts references and records the materials it bound. */
class FakeTables implements BatchTables {
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

interface Setup {
  scene: Scene
  world: World
  stream: RegionStreamer
  fx: Fixture
  parts: RegionBatchPart[]
  /** Model indices loaded (in load order). */
  loads: number[]
  /** The skinned tree, its static variant, the static tree. */
  ids: { skinned: number; variant: number; pine: number }
  run(): Promise<void>
}

/**
 * The stream fixture plus a skinned tree (with a static variant placed nowhere itself) and a static tree in every
 * region, each at its own spot, next to model 0 (a wall).
 */
interface TreeWorldOptions {
  render?: RenderPath
  tables?: BatchTables | null
  mode?: TreeMode
  /** T12-M: changes the manifest (and the fixture's files) before the world is made. */
  edit?: (fx: Fixture, ids: Setup['ids']) => void
  /** T12-M: a model's own container (the species' far.glb stand-in). */
  container?: (scene: Scene, model: WorldModel) => { container: AssetContainer; sidecar: SidecarLite } | null
  /** T12-M: the trees part (T12-N's slots; default: the world's stub). */
  trees?: TreesFactory | null
  /** T12-M: the render quality (High: the trees cast, the worker builds the caster). */
  quality?: RenderQuality
}

async function treeWorld(o: TreeWorldOptions = {}): Promise<Setup> {
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
  const tables = o.tables === undefined ? new FakeTables() : o.tables
  const world = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, {
    baseUrl: BASE_URL, minimap: false, render: o.render ?? 'pbr',
    parts: {
      batch: host => {
        // these tests read the merged arrays back (H-12 MM1 frees a tree group's CPU copy otherwise)
        const p = new RegionBatchPart(host, { tables, worker: null, trees: o.mode ? { mode: o.mode } : undefined, keepCpuCopies: true })
        parts.push(p)
        return p
      },
      life: null, ocean: null,
      ...(o.trees !== undefined ? { trees: o.trees } : {}),
    },
  })
  if (o.quality) world.render.quality = o.quality
  await world.water.init(assets)
  const loads: number[] = []
  const prims = (m: WorldModel): Prim[] => (m.index === ids.variant || m.index === ids.skinned ? [LEAF, BARK] : m.index === ids.pine ? [BARK, LEAF] : [WALL])
  const loadModel = async (model: WorldModel): Promise<CachedModel> => {
    loads.push(model.index)
    const { container, sidecar } = o.container?.(scene, model) ?? modelContainer(scene, model, prims(model))
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
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { scene, world, stream, fx, parts, loads, ids, run }
}

const isTreeMesh = (m: { metadata?: unknown }) => !!(m.metadata as { sroTree?: boolean } | null)?.sroTree
const liveTreeMeshes = (scene: Scene) => scene.meshes.filter(m => isTreeMesh(m) && !m.isDisposed())

// ---- tests --------------------------------------------------------------------------------------------------------

describe('static variants (BATCHING §3.5)', () => {
  it('staticVariantOf: a skinned foliage model with a loadable static variant only', () => {
    const base = { sidecar: null, animations: [], defaultClip: null, lightmappedMeshes: 0, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], bytes: 0, validatorErrors: null }
    const models = [
      { ...base, index: 0, source: TREE_SKINNED, glb: 'models/a.glb', kind: 'skinned', staticVariant: 1 },
      { ...base, index: 1, source: `${TREE_SKINNED}#static`, glb: 'models/a.static.glb', kind: 'static' },
      { ...base, index: 2, source: 'res\\bldg\\flag01.bsr', glb: 'models/f.glb', kind: 'skinned', staticVariant: 1 },
      { ...base, index: 3, source: TREE_SKINNED, glb: 'models/b.glb', kind: 'skinned', staticVariant: 4 },
      { ...base, index: 4, source: `${TREE_SKINNED}#static`, glb: null, kind: 'failed' },
      { ...base, index: 5, source: TREE_SKINNED, glb: 'models/c.glb', kind: 'skinned' },
      { ...base, index: 6, source: 'res\\nature\\common\\flower\\flw_s01_y_ani.bsr', glb: 'models/d.glb', kind: 'skinned', staticVariant: 1 },
      { ...base, index: 7, source: 'res\\nature\\china\\dunhuang\\reed\\fw_cd_reeds_l.bsr', glb: 'models/e.glb', kind: 'skinned', staticVariant: 1 },
      { ...base, index: 8, source: 'res\\nature\\common\\grass\\grs_weed04.bsr', glb: 'models/g.glb', kind: 'skinned', staticVariant: 1 },
    ] as unknown as WorldModel[]
    expect(staticVariantOf(models[0]!, models)?.index).toBe(1)
    expect(staticVariantOf(models[6]!, models)?.index).toBe(1)
    // Not foliage (a flag), a failed variant, no variant, a static model itself.
    expect(staticVariantOf(models[2]!, models)).toBeNull()
    expect(staticVariantOf(models[3]!, models)).toBeNull()
    expect(staticVariantOf(models[5]!, models)).toBeNull()
    expect(staticVariantOf(models[1]!, models)).toBeNull()
    // The reeds and the tall grass keep their retail clip (an h² bend cannot sway a plant that short).
    expect(staticVariantOf(models[7]!, models)).toBeNull()
    expect(staticVariantOf(models[8]!, models)).toBeNull()
    expect(foliageKindOf(models[7]!.source)).toBe('reed')
    expect(foliageKindOf('res\\nature\\common\\tree2\\x.bsr')).toBe('tree')
    expect(foliageKindOf('res\\bldg\\china\\greenfield\\cj_inn_oldtree.bsr')).toBeNull()
  })

  it('Medium+ with batching loads the static variant, never the skinned glb, and makes no clone', async () => {
    const s = await treeWorld()
    await s.run()
    expect(s.loads).toContain(s.ids.variant)
    expect(s.loads).not.toContain(s.ids.skinned)
    // Model 1 of the stream fixture is a plain skinned prop (not foliage): it stays a clone.
    expect(s.world.objects.stats.clones).toBe(1)
    expect(s.parts[0]!.modelFor(s.fx.manifest.models[s.ids.skinned]!).index).toBe(s.ids.variant)
  })

  it('Low (Classic) and the material mode load nothing new: the skinned tree stays a clone', async () => {
    const low = await treeWorld({ render: 'classic' })
    await low.run()
    expect(low.parts.length).toBe(0)
    expect(low.loads).not.toContain(low.ids.variant)
    expect(low.loads).toContain(low.ids.skinned)
    const regions = low.stream.stats.ready
    expect(low.world.objects.stats.clones).toBe(1 + regions)

    const mat = await treeWorld({ tables: null })
    await mat.run()
    expect(mat.loads).not.toContain(mat.ids.variant)
    expect(mat.loads).toContain(mat.ids.skinned)
    expect(liveTreeMeshes(mat.scene).length).toBe(0)
  })
})

describe('tree groups (merge mode)', () => {
  it('a region\'s trees are ≤ 2 draws (cut-out leaves, opaque wood) on two shared tree materials', async () => {
    const tables = new FakeTables()
    const s = await treeWorld({ tables })
    await s.run()
    const part = s.parts[0]!
    const regions = s.stream.stats.ready
    expect(regions).toBeGreaterThan(1)
    expect(part.stats.treeClaims).toBe(2 * regions)
    for (const owner of s.world.objects.regionBatches.keys()) {
      const trees = part.batchOf(owner)!.meshes.filter(isTreeMesh)
      expect(trees.length).toBeLessThanOrEqual(2)
      expect(trees.map(m => m.name.split(':').slice(2).join(':')).sort()).toEqual(['2:tree:leaf+cutout', '2:tree:wood'])
    }
    // Two tree materials in the whole world, bound to the table as plain (no sheen, no lamp) cut-out / opaque groups.
    const mats = new Set(liveTreeMeshes(s.scene).map(m => m.material))
    expect(mats.size).toBe(2)
    const bound = tables.bound.filter(b => (b.material.metadata as { sroTree?: boolean } | null)?.sroTree)
    expect(bound.map(b => b.key).sort((a, b) => Number(a.cutout) - Number(b.cutout))).toEqual([
      { cutout: false, sheen: false, lamp: false },
      { cutout: true, sheen: false, lamp: false },
    ])
    // No foliage chunk and no skinned tree clone is left: the trees are all in the batch.
    const treeChunk = new RegExp(`@m(${s.ids.variant}|${s.ids.pine}|${s.ids.skinned})\\|`)
    expect(s.world.objects.meshes().filter(m => treeChunk.test(m.name)).length).toBe(0)
    expect(s.world.objects.stats.chunks).toBe(0)
  })

  it('every merged vertex carries its own tree\'s root; the foliage plugin bends around it with the minimum breeze', async () => {
    const s = await treeWorld()
    await s.run()
    const roots = s.fx.manifest.placements.filter(p => p.models[0] === s.ids.skinned || p.models[0] === s.ids.pine).map(p => p.position)
    const meshes = liveTreeMeshes(s.scene)
    expect(meshes.length).toBeGreaterThan(0)
    for (const m of meshes) {
      const pos = m.getVerticesData('position')!
      const piv = m.getVerticesData(FOLIAGE_PIVOT_KIND)!
      expect(piv.length).toBe(pos.length)
      for (let v = 0; v < pos.length / 3; v++) {
        const p = [piv[v * 3]!, piv[v * 3 + 1]!, piv[v * 3 + 2]!]
        // The pivot is exactly one tree's placement origin, and that tree is the nearest root to the vertex.
        const near = roots.reduce((best, r) => (Math.hypot(r[0] - pos[v * 3]!, r[2] - pos[v * 3 + 2]!) < Math.hypot(best[0] - pos[v * 3]!, best[2] - pos[v * 3 + 2]!) ? r : best))
        expect(p).toEqual([Math.fround(near[0]), Math.fround(near[1]), Math.fround(near[2])])
      }
      const mat = m.material as PBRMaterial
      const fol = foliagePluginOf(mat)!
      expect(fol).not.toBeNull()
      expect(fol.kind).toBe('static')
      expect(fol.breeze).toBe(TREE_BREEZE)
      expect(fol.leaf).toBe(m.name.includes('leaf'))
      const d = {} as Record<string, boolean>
      fol.prepareDefines(d as unknown as MaterialDefines, s.scene, m)
      expect(d.SRO_FOL_WIND).toBe(true)
      expect(d.SRO_FOL_PIVOT).toBe(true)
      expect(d.SRO_FOL_BREEZE).toBe(true)
      expect(d.SRO_FOL_FLUTTER).toBe(fol.leaf)
    }
  })

  it('tree keys: leaf/wood from the class, cut-out/opaque from the alpha mode', () => {
    expect(treeKeyName(treeKeyOf({ cls: 'foliage', alpha: 'mask' }))).toBe('tree:leaf+cutout')
    expect(treeKeyName(treeKeyOf({ cls: 'wood', alpha: 'opaque' }))).toBe('tree:wood')
    expect(treeKeyName(treeKeyOf({ cls: 'wood', alpha: 'mask' }))).toBe('tree:wood+cutout')
  })

  it('batching off (and back on) leaves no tree mesh or slot; the trees come back as the retail clones and chunks', async () => {
    const tables = new FakeTables()
    const s = await treeWorld({ tables })
    await s.run()
    expect(liveTreeMeshes(s.scene).length).toBeGreaterThan(0)
    s.world.setBatching(false)
    await s.run()
    expect(liveTreeMeshes(s.scene).length).toBe(0)
    expect(tables.live).toBe(0)
    const regions = s.stream.stats.ready
    // Off = HEAD: the skinned tree is a clone in every region again.
    expect(s.world.objects.stats.clones).toBe(1 + regions)
    s.world.setBatching(true)
    await s.run()
    expect(liveTreeMeshes(s.scene).length).toBeGreaterThan(0)
    expect(s.world.objects.stats.clones).toBe(1)
  })
})

describe('the per-model instancing fallback (mode: instance)', () => {
  it('one world-wide set per (model, primitive) holds every region\'s trees; no tree goes into a region batch', async () => {
    const s = await treeWorld({ mode: 'instance' })
    await s.run()
    const part = s.parts[0]!
    const regions = s.stream.stats.ready
    expect(part.stats.treeSets).toBe(4)
    expect(part.stats.treeInstances).toBe(4 * regions)
    for (const owner of s.world.objects.regionBatches.keys()) expect(part.batchOf(owner)!.meshes.filter(m => m.name.startsWith('batch:') && isTreeMesh(m)).length).toBe(0)
    expect(s.loads).toContain(s.ids.variant)
    expect(s.loads).not.toContain(s.ids.skinned)
    // The sets are World meshes; the static variant's converted materials got the minimum breeze.
    const sets = part.meshes().filter(isTreeMesh)
    expect(sets.length).toBe(4)
    for (const m of sets) expect(foliagePluginOf(m.material!)?.breeze).toBe(TREE_BREEZE)
    s.world.setBatching(false)
    await s.run()
    expect(liveTreeMeshes(s.scene).length).toBe(0)
  })

  it('culls by range, never draws at count 0, and restores the breeze on release', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const src = MeshBuilder.CreateBox('src', { size: 1 }, scene)
    const mat = new PBRMaterial('leaf', scene)
    const fol = new SroFoliagePlugin(mat, new FoliageShared(), { leaf: true, kind: 'static' })
    src.material = mat
    src.setEnabled(false)
    const model = { index: 7, source: TREE_STATIC, boundsMin: [-1, 0, -1], boundsMax: [1, 4, 1] } as unknown as WorldModel
    const at = (x: number, z: number, uid: number) => ({ position: [x, 0, z], rotation: [0, 0, 0, 1], group: 2, uid } as unknown as WorldPlacement)
    const set = new TreeInstances(scene)
    set.add(1, model, { geometry: [src], locals: [src.computeWorldMatrix(true).clone()] }, [at(0, 0, 1), at(150, 0, 2)])
    set.add(2, model, { geometry: [src], locals: [src.computeWorldMatrix(true).clone()] }, [at(600, 0, 3)])
    expect(set.setCount).toBe(1)
    expect(fol.breeze).toBe(TREE_BREEZE)
    const mesh = set.meshes()[0] as Mesh
    // Built hidden at count 0.
    expect(mesh.thinInstanceCount).toBe(0)
    expect(mesh.isVisible).toBe(false)
    set.update({ x: 0, y: 0, z: 0 })
    expect(mesh.thinInstanceCount).toBe(2)
    expect(mesh.isVisible).toBe(true)
    expect([...set.casters()]).toEqual([mesh])
    // A small move does not re-test; past TREE_INSTANCE_STEP_M it does.
    set.update({ x: 3, y: 0, z: 0 })
    expect(mesh.thinInstanceCount).toBe(2)
    set.update({ x: 600, y: 0, z: 0 })
    expect(mesh.thinInstanceCount).toBe(1)
    // Far from everything: count 0 is hidden, and casts nothing.
    set.update({ x: 5000, y: 0, z: 5000 })
    expect(mesh.thinInstanceCount).toBe(0)
    expect(mesh.isVisible).toBe(false)
    expect([...set.casters()]).toEqual([])
    // The range scale (Options' sight, the create screen's 0.6) applies at once.
    set.update({ x: 0, y: 0, z: 0 })
    set.setRangeScale(0.6)
    set.update({ x: 0, y: 0, z: 0 })
    expect(mesh.thinInstanceCount).toBe(1)
    // A region going takes its instances; the last one takes the set.
    set.remove(1)
    set.update({ x: 0, y: 0, z: 0 }, true)
    expect(mesh.thinInstanceCount).toBe(0)
    expect(mesh.isVisible).toBe(false)
    set.remove(2)
    expect(set.setCount).toBe(0)
    expect(mesh.isDisposed()).toBe(true)
    set.add(3, model, { geometry: [src], locals: [src.computeWorldMatrix(true).clone()] }, [at(0, 0, 4)])
    set.release()
    expect(set.setCount).toBe(0)
    expect(fol.breeze).toBe(0)
  })
})

// ---- wave 12: the swap (T12-M; TREES §W3.2–§W3.6, WF8, WF10–WF12, WF15) ---------------------------------------------

/** The species' wind data per (part, tier): the decoded (flex, phase, flutter, crown AO); the glb holds V flipped. */
const WIND: Record<string, [number, number, number, number]> = {
  'leaf:1': [0.8, 0.25, 0.6, 0.7],
  'leaf:2': [0.9, 0.5, 0.4, 0.6],
  'bark:1': [0.2, 0.25, 0, 0.9],
  'bark:2': [0.3, 0.5, 0, 0.8],
}
const SPECIES = 'pine07'
const SPECIES_GLB = `models/trees/${SPECIES}/far.glb`
const SPECIES_SIDE = `models/trees/${SPECIES}/far.json`
const TINT_KEY = `prim\\mtrl\\nature\\common\\tree\\tre_w12_${SPECIES}_leaf_red.ddj`
const TINT_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))

/** The species' far.glb stand-in: per tier a node `lod<t>` with a bark box and a leaf card carrying the wind UVs. */
function speciesContainer(scene: Scene, model: WorldModel): { container: AssetContainer; sidecar: SidecarLite } {
  const container = new AssetContainer(scene)
  const root = new TransformNode(`${model.glb}#root`, scene)
  scene.removeTransformNode(root)
  container.transformNodes.push(root)
  container.rootNodes.push(root)
  const mats = new Map<string, PBRMaterial>()
  for (const part of ['bark', 'leaf']) {
    const m = new PBRMaterial(`${SPECIES}_${part}`, scene)
    scene.removeMaterial(m)
    if (part === 'leaf') m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    mats.set(part, m)
    container.materials.push(m)
  }
  for (const tier of [1, 2]) {
    const node = new TransformNode(`lod${tier}`, scene)
    scene.removeTransformNode(node)
    node.parent = root
    container.transformNodes.push(node)
    ;['bark', 'leaf'].forEach((part, i) => {
      const mesh = (part === 'leaf'
        ? MeshBuilder.CreatePlane(`lod${tier}_primitive${i}`, { size: tier === 1 ? 3 : 4 }, scene)
        : MeshBuilder.CreateBox(`lod${tier}_primitive${i}`, { size: 0.5 }, scene)) as Mesh
      scene.removeMesh(mesh)
      mesh.parent = node
      mesh.position.set(0, part === 'leaf' ? 4 : 1, 0)
      const [flex, phase, flutter, ao] = WIND[`${part}:${tier}`]!
      const n = mesh.getTotalVertices()
      const uv2 = new Float32Array(n * 2)
      const uv3 = new Float32Array(n * 2)
      for (let v = 0; v < n; v++) {
        uv2[v * 2] = flex
        uv2[v * 2 + 1] = 1 - phase
        uv3[v * 2] = flutter
        uv3[v * 2 + 1] = 1 - ao
      }
      mesh.setVerticesData(VertexBuffer.UV2Kind, uv2, false, 2)
      mesh.setVerticesData(VertexBuffer.UV3Kind, uv3, false, 2)
      mesh.material = mats.get(part)!
      container.meshes.push(mesh)
    })
  }
  const tex = (part: string) => `prim\\mtrl\\nature\\common\\tree\\tre_w12_${SPECIES}_${part}.ddj`
  const sidecar: SidecarLite = {
    materials: [
      { name: `${SPECIES}_bark`, flags: 0, diffuse: [], ambient: [], texture: tex('bark'), alphaMode: 'OPAQUE' },
      { name: `${SPECIES}_leaf`, flags: 0, diffuse: [], ambient: [], texture: tex('leaf'), alphaMode: 'MASK' },
    ],
  }
  return { container, sidecar }
}

const speciesOnly = (scene: Scene, model: WorldModel) => (model.glb === SPECIES_GLB ? speciesContainer(scene, model) : null)

/**
 * The swap as the converter writes it (trees-manifest.ts): the species appended as a static model, the pine swapped to
 * it (fit 1.5 / 0.5, optionally a trunk offset), the skinned maple too (optionally tinted), optionally cj_ricestraw
 * (not a foliage path, WF12) and a second pine per region (uid + 5000, 5 m east).
 */
function withSwap(o: { tint?: boolean; offset?: boolean; straw?: boolean; twoPines?: boolean } = {}) {
  const out = { species: -1, straw: -1 }
  const edit = (fx: Fixture, ids: Setup['ids']) => {
    const models = fx.manifest.models
    out.species = models.length
    models.push({ ...models[ids.pine]!, index: out.species, source: `res\\nature\\common\\tree\\w12\\${SPECIES}.bsr#species`, glb: SPECIES_GLB, sidecar: SPECIES_SIDE, kind: 'static' })
    models[ids.pine]!.treeSwap = { model: out.species, fit: [1.5, 0.5, 1.5], tint: 0, ...(o.offset ? { offset: [2, 0, -1] as [number, number, number] } : {}) }
    models[ids.skinned]!.treeSwap = { model: out.species, fit: [1, 1, 1], tint: o.tint ? 1 : 0 }
    const tints = o.tint ? [{ name: 'red', materials: { [`${SPECIES}_leaf`]: { texture: TINT_KEY, image: 'tints/red-leaf.png' } } }] : []
    fx.files.set(BASE_URL + SPECIES_SIDE, json({ trees: { tints } }))
    if (o.tint) fx.files.set(`${BASE_URL}models/trees/${SPECIES}/tints/red-leaf.png`, TINT_PNG)
    if (o.straw) {
      out.straw = addModel(fx, 'res\\nature\\common\\cj_ricestraw.bsr')
      models[out.straw]!.treeSwap = { model: out.species, fit: [1, 1, 1], tint: 0 }
    }
    if (o.twoPines) {
      for (const p of fx.manifest.placements.filter(q => q.models[0] === ids.pine)) {
        fx.manifest.placements.push({ ...p, uid: p.uid + 5000, position: [p.position[0] + 5, p.position[1], p.position[2]] })
      }
    }
  }
  return { out, edit }
}

/** T12-N's slot allocator stand-in: a slot per placement key on first ask, −1 for the keys `refuse` names. */
class SlotTrees extends StubTrees {
  readonly slots = new Map<number, number>()

  constructor(host: TreesHost, readonly refuse: (key: number) => boolean) {
    super(host)
  }

  slotOf(key: number): number {
    if (this.refuse(key)) return -1
    let s = this.slots.get(key)
    if (s === undefined) this.slots.set(key, (s = this.slots.size))
    return s
  }
}

function slotTrees(refuse: (key: number) => boolean = () => false): { made: SlotTrees[]; factory: TreesFactory } {
  const made: SlotTrees[] = []
  return {
    made,
    factory: host => {
      const t = new SlotTrees(host, refuse)
      made.push(t)
      return t
    },
  }
}

/** Per region (by id), the sorted labels of its batch meshes: the draws. */
function drawsOf(s: Setup): string[][] {
  const part = s.parts.at(-1)!
  return [...s.world.objects.regionBatches.keys()]
    .map(o => part.batchOf(o)!)
    .sort((a, b) => a.region - b.region)
    .map(b => b.meshes.map(m => m.name.split(':').slice(2).join(':')).sort())
}

/** Every swapped tree's root (position + the pine's offset; no rotation, scale 1), its key, and which model it is. */
function swappedRoots(s: Setup, offset: readonly number[] = [0, 0, 0]): Array<{ root: number[]; key: number; pine: boolean }> {
  return s.fx.manifest.placements
    .filter(p => p.models[0] === s.ids.pine || p.models[0] === s.ids.skinned)
    .map(p => {
      const pine = p.models[0] === s.ids.pine
      const o = pine ? offset : [0, 0, 0]
      return { root: [p.position[0] + o[0]!, p.position[1] + o[1]!, p.position[2] + o[2]!], key: placementKey(p.region, p.uid), pine }
    })
}

function nearestRoot<T extends { root: number[] }>(roots: readonly T[], x: number, y: number, z: number): T {
  let best = roots[0]!
  let bd = Infinity
  for (const r of roots) {
    const d = Math.hypot(r.root[0]! - x, r.root[1]! - y, r.root[2]! - z)
    if (d < bd) {
      bd = d
      best = r
    }
  }
  return best
}

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps
const BYTE = 1 / 255 + 1e-6

describe('the swap (T12-M, TREES §W3.2–§W3.4)', () => {
  it('a swapped model loads its species (never its retail glb, no clone) and merges into the same tree groups: draws per region unchanged', async () => {
    const base = await treeWorld()
    await base.run()
    const sw = withSwap()
    const t = slotTrees()
    const s = await treeWorld({ edit: sw.edit, container: speciesOnly, trees: t.factory })
    await s.run()
    expect(s.world.trees).toBe(t.made[0])
    expect(s.loads).toContain(sw.out.species)
    for (const retail of [s.ids.pine, s.ids.skinned, s.ids.variant]) expect(s.loads).not.toContain(retail)
    // Only the stream fixture's skinned prop is a clone: the swapped skinned maple makes none.
    expect(s.world.objects.stats.clones).toBe(1)
    const part = s.parts.at(-1)!
    const regions = s.stream.stats.ready
    expect(part.stats.treeSwapped).toBe(2 * regions)
    expect(part.modelFor(s.fx.manifest.models[s.ids.pine]!).index).toBe(sw.out.species)
    expect(drawsOf(s)).toEqual(drawsOf(base))
  })

  it('every merged vertex: its root and band word (slot × 4 + tier), LOD1 first, sroTreeW decoded within 1/255, uv2 the white quadrant', async () => {
    const sw = withSwap({ offset: true })
    const t = slotTrees()
    const s = await treeWorld({ edit: sw.edit, container: speciesOnly, trees: t.factory })
    await s.run()
    const roots = swappedRoots(s, [2, 0, -1])
    const meshes = liveTreeMeshes(s.scene)
    expect(meshes.length).toBeGreaterThan(0)
    const tiers = new Set<number>()
    for (const m of meshes) {
      const n = m.getTotalVertices()
      const piv = m.getVerticesData(FOLIAGE_PIVOT_KIND)!
      const w = m.getVerticesData(FOLIAGE_TREEW_KIND)!
      const uv2 = m.getVerticesData(VertexBuffer.UV2Kind)!
      expect(m.getVertexBuffer(FOLIAGE_PIVOT_KIND)!.getSize()).toBe(4)
      expect(m.getVertexBuffer(FOLIAGE_TREEW_KIND)!.type).toBe(VertexBuffer.UNSIGNED_BYTE)
      expect(m.getVertexBuffer(FOLIAGE_TREEW_KIND)!.normalized).toBe(true)
      const part = m.name.includes('leaf') ? 'leaf' : 'bark'
      let last = 0
      let tier1 = 0
      for (let v = 0; v < n; v++) {
        const r = nearestRoot(roots, piv[v * 4]!, piv[v * 4 + 1]!, piv[v * 4 + 2]!)
        for (let a = 0; a < 3; a++) expect(near(piv[v * 4 + a]!, r.root[a]!, 1e-3)).toBe(true)
        const band = bandOfWord(piv[v * 4 + 3]!)
        expect(band.slot).toBe(t.made[0]!.slots.get(r.key))
        expect([1, 2]).toContain(band.tier)
        // The tier-1 pieces come first (the caster's LOD1 prefix).
        expect(band.tier).toBeGreaterThanOrEqual(last)
        last = band.tier
        if (band.tier === 1) tier1++
        tiers.add(band.tier)
        const want = WIND[`${part}:${band.tier}`]!
        for (let c = 0; c < 4; c++) expect(near(w[v * 4 + c]!, want[c]!, BYTE)).toBe(true)
        // The wind data is not a lightmap UV: the fake table's white quadrant centre (scale 0.5, offset 0.5, 0).
        const u = unpackUv2(uv2[v * 2]!, uv2[v * 2 + 1]!)
        expect([u.layer, +u.u.toFixed(4), +u.v.toFixed(4)]).toEqual([0, 0.75, 0.25])
      }
      expect(casterPrefixOf(m)?.vertices).toBe(tier1)
      expect(tier1).toBeLessThan(n)
    }
    expect([...tiers].sort()).toEqual([1, 2])
    // The groups' materials are the tree plugin's (SRO_FOL_VDATA / SRO_FOL_BAND / the vec4 pivot follow the mesh data).
    expect(foliagePluginOf(meshes[0]!.material!)!.tree).toBe(true)
  })

  it('a swapped tree without a band slot draws its LOD1 at every distance (tier 0) and no LOD2; a slotted neighbour keeps both', async () => {
    // No slot source at all (a trees part without `slotOf`): every swapped tree is tier 0, LOD1 only.
    const none = await treeWorld({ edit: withSwap().edit, container: speciesOnly, trees: host => new StubTrees(host) })
    await none.run()
    const regions = none.stream.stats.ready
    expect(none.parts.at(-1)!.stats.treeUnslotted).toBe(2 * regions)
    for (const m of liveTreeMeshes(none.scene)) {
      const piv = m.getVerticesData(FOLIAGE_PIVOT_KIND)!
      const w = m.getVerticesData(FOLIAGE_TREEW_KIND)!
      const part = m.name.includes('leaf') ? 'leaf' : 'bark'
      for (let v = 0; v < m.getTotalVertices(); v++) {
        expect(piv[v * 4 + 3]).toBe(0)
        expect(near(w[v * 4]!, WIND[`${part}:1`]![0], BYTE)).toBe(true)
      }
      expect(casterPrefixOf(m)).toBeNull()
    }
    // Two pines per region, the second (uid + 5000) without a slot: it draws LOD1 only, its neighbour both tiers.
    const t = slotTrees(key => (key & 0xffff) >= 5000)
    const s = await treeWorld({ edit: withSwap({ twoPines: true }).edit, container: speciesOnly, trees: t.factory })
    await s.run()
    const roots = s.fx.manifest.placements.filter(p => p.models[0] === s.ids.pine).map(p => ({ root: [...p.position], refused: p.uid >= 5000 }))
    const seen = { refused: new Set<number>(), slotted: new Set<number>() }
    for (const m of liveTreeMeshes(s.scene)) {
      const piv = m.getVerticesData(FOLIAGE_PIVOT_KIND)!
      for (let v = 0; v < m.getTotalVertices(); v++) {
        const r = nearestRoot(roots, piv[v * 4]!, piv[v * 4 + 1]!, piv[v * 4 + 2]!)
        if (Math.hypot(r.root[0]! - piv[v * 4]!, r.root[2]! - piv[v * 4 + 2]!) > 1e-3) continue
        const { tier } = bandOfWord(piv[v * 4 + 3]!)
        if (r.refused) seen.refused.add(tier)
        else seen.slotted.add(tier)
      }
    }
    expect([...seen.refused]).toEqual([0])
    expect([...seen.slotted].sort()).toEqual([1, 2])
  })

  it('a tinted retail model\'s leaves take their tint\'s own record and slot (the species\' converted material untouched)', async () => {
    const tables = new FakeTables()
    const s = await treeWorld({ edit: withSwap({ tint: true }).edit, container: speciesOnly, trees: slotTrees().factory, tables })
    await s.run()
    const recs = [...tables.refs.keys()]
    const tint = recs.find(r => r.texture === TINT_KEY)!
    const leaf = recs.find(r => r.name === `${SPECIES}_leaf` && r.texture !== TINT_KEY)!
    expect(tint).toBeDefined()
    expect(leaf).toBeDefined()
    expect([tint.name, tint.cls, tint.alpha]).toEqual([leaf.name, leaf.cls, leaf.alpha])
    const albedo = (tint.material as PBRMaterial).albedoTexture!
    expect(albedo.name).toBe(`sroTint:${TINT_KEY}`)
    expect([...(albedo.getInternalTexture() as unknown as { _buffer: Uint8Array })._buffer]).toEqual([...TINT_PNG])
    // The converted leaf material keeps its own albedo (the tint is a view, never a change).
    expect((leaf.material as PBRMaterial).albedoTexture).not.toBe(albedo)
    expect(s.parts.at(-1)!.stats.treeTints).toBe(1)
    const slotTint = tables.refs.get(tint)!.entry.slot
    const slotLeaf = tables.refs.get(leaf)!.entry.slot
    const roots = swappedRoots(s)
    const slots = { maple: new Set<number>(), pine: new Set<number>() }
    for (const m of liveTreeMeshes(s.scene).filter(x => x.name.includes('leaf'))) {
      const piv = m.getVerticesData(FOLIAGE_PIVOT_KIND)!
      const uv2 = m.getVerticesData(VertexBuffer.UV2Kind)!
      for (let v = 0; v < m.getTotalVertices(); v++) {
        const r = nearestRoot(roots, piv[v * 4]!, piv[v * 4 + 1]!, piv[v * 4 + 2]!)
        slots[r.pine ? 'pine' : 'maple'].add(unpackUv2(uv2[v * 2]!, uv2[v * 2 + 1]!).slot)
      }
    }
    expect([...slots.maple]).toEqual([slotTint])
    expect([...slots.pine]).toEqual([slotLeaf])
  })

  it('cj_ricestraw with treeSwap is a tree claim (WF12); disposing the tree groups leaves clothGroups at 0 (WF8)', async () => {
    const sw = withSwap({ straw: true })
    const s = await treeWorld({ edit: sw.edit, container: speciesOnly, trees: slotTrees().factory })
    await s.run()
    const part = s.parts.at(-1)!
    const regions = s.stream.stats.ready
    expect(part.stats.treeSwapped).toBe(3 * regions)
    expect(s.loads).not.toContain(sw.out.straw)
    const straws = s.fx.manifest.placements.filter(p => p.models[0] === sw.out.straw).map(p => p.position)
    let found = 0
    for (const m of liveTreeMeshes(s.scene)) {
      const piv = m.getVerticesData(FOLIAGE_PIVOT_KIND)!
      for (let v = 0; v < m.getTotalVertices(); v++) {
        if (straws.some(p => near(p[0], piv[v * 4]!, 1e-3) && near(p[2], piv[v * 4 + 2]!, 1e-3))) found++
      }
    }
    expect(found).toBeGreaterThan(0)
    expect(part.stats.clothGroups).toBe(0)
    s.world.setBatching(false)
    await s.run()
    expect(liveTreeMeshes(s.scene).length).toBe(0)
    expect(part.stats.clothGroups).toBe(0)
  })

  it('High: the merge worker returns the cut-out caster (the LOD1 prefixes only); Medium: none', async () => {
    const medium = await treeWorld({ edit: withSwap().edit, container: speciesOnly, trees: slotTrees().factory })
    await medium.run()
    for (const o of medium.world.objects.regionBatches.keys()) {
      expect((medium.parts.at(-1)!.batchOf(o) as unknown as { casterData: unknown }).casterData).toBeNull()
    }
    const s = await treeWorld({ edit: withSwap().edit, container: speciesOnly, trees: slotTrees().factory, quality: RENDER_PRESETS.high })
    await s.run()
    const part = s.parts.at(-1)!
    let checked = 0
    let far = 0
    // H-12 MM3: the worker builds the caster arrays only for regions within the caster drop range of the focus
    const focus = s.world.stream!.focusPoint
    const reach = (RENDER_PRESETS.high.shadows?.foliageM ?? 0) + CASTER_DROP_MARGIN_M
    for (const o of s.world.objects.regionBatches.keys()) {
      const b = part.batchOf(o)!
      const r = s.world.manifest.regions.find(q => q.id === b.region)!
      const d = Math.hypot(Math.max(r.origin[0] - focus.x, 0, focus.x - r.origin[0] - 192), Math.max(r.origin[2] - 192 - focus.z, 0, focus.z - r.origin[2]))
      const data = (b as unknown as { casterData: { positions: Float32Array; indices: Uint32Array; cull: Float32Array; groups: number } | null }).casterData!
      if (d > reach) {
        expect(data).toBeNull()
        // ... and the worker builds it on demand when the camera comes near (no main-thread copy, WF15)
        const req = b as unknown as { requestCaster(): boolean; casterData: { groups: number } | null }
        expect(req.requestCaster()).toBe(true)
        for (let i = 0; i < 50 && !req.casterData; i++) await new Promise(r => setTimeout(r, 5))
        expect(req.casterData?.groups).toBe(b.cutoutCasters.length)
        far++
        continue
      }
      expect(data).not.toBeNull()
      expect(data.groups).toBe(b.cutoutCasters.length)
      let nv = 0
      let ni = 0
      let total = 0
      for (const m of b.cutoutCasters) {
        const pre = casterPrefixOf(m)
        nv += pre?.vertices ?? m.getTotalVertices()
        ni += pre?.indices ?? m.getTotalIndices()
        total += m.getTotalVertices()
      }
      expect(data.positions.length / 3).toBe(nv)
      expect(data.indices.length).toBe(ni)
      expect(nv).toBeLessThan(total)
      // Group 2 never collapses.
      expect(data.cull[3]).toBe(-1)
      // The first group's LOD1 positions, as its mesh holds them.
      const first = b.cutoutCasters[0]!.getVerticesData(VertexBuffer.PositionKind)!
      expect([...data.positions.subarray(0, 9)]).toEqual([...first].slice(0, 9))
      checked++
    }
    expect(checked).toBeGreaterThan(1)
    expect(far).toBeGreaterThan(0)
  })
})

describe('the swap\'s maths (T12-M)', () => {
  it('foldSwap: v ⊙ fit + offset, then the placement; its translation is the species\' root on the retail trunk', () => {
    const P = Matrix.Compose(new Vector3(2, 2, 2), Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2), new Vector3(10, 1, 20))
    const m = new Float32Array(32)
    P.copyToArray(m, 16)
    foldSwap(m, 16, [2, 3, 4], [5, 0, 6])
    const folded = Matrix.FromArray(m, 16)
    const got = Vector3.TransformCoordinates(new Vector3(1, 1, 1), folded)
    const want = Vector3.TransformCoordinates(new Vector3(1 * 2 + 5, 1 * 3, 1 * 4 + 6), P)
    expect(got.subtract(want).length()).toBeLessThan(1e-4)
    const root = Vector3.TransformCoordinates(new Vector3(5, 0, 6), P)
    expect(new Vector3(m[28]!, m[29]!, m[30]!).subtract(root).length()).toBeLessThan(1e-4)
    // The rest of the array is untouched; no fit and no offset leave the matrix as it was.
    expect([...m.subarray(0, 16)]).toEqual(new Array(16).fill(0))
    const id = new Float32Array(P.m)
    foldSwap(id, 0, [1, 1, 1], undefined)
    expect([...id]).toEqual([...new Float32Array(P.m)])
    expect(bandWord(7, 2)).toBe(30)
    expect(bandWord(-1, 2)).toBe(0)
    expect(bandWord(7, 0)).toBe(0)
    expect(bandOfWord(30)).toEqual({ slot: 7, tier: 2 })
  })

  it('merge-core: tier 2 last (the LOD1 prefix), sroTreeW from the wind UVs or the h² shape, the caster arrays; none without the flags', () => {
    const tri = (y: number): MergePrimitive => ({
      positions: new Float32Array([0, y, 0, 1, y, 0, 0, y, 1]),
      normals: null,
      uvs: new Float32Array(6),
      // flex 0.2, phase 1 − 0.75 = 0.25; flutter 0.6, AO 1 − 0.2 = 0.8.
      uvs2: new Float32Array([0.2, 0.75, 0.2, 0.75, 0.2, 0.75]),
      uvs3: new Float32Array([0.6, 0.2, 0.6, 0.2, 0.6, 0.2]),
      indices: new Uint32Array([0, 1, 2]),
      mirrored: false,
    })
    const models = new Map([[1, { primitives: [tri(4), tri(8)] }], [2, { primitives: [{ ...tri(6), uvs2: null, uvs3: null }] }]])
    const at = (x: number) => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1])
    const pack = { slot: 3, layer: 0, scale: 0.5, offsetU: 0.5, offsetV: 0 }
    const job: MergeGroupJob = {
      key: 'g', pivotSize: 4, proxy: false, treeW: true, leaf: true, caster: { lod: 3 },
      pieces: [
        { model: 1, primitive: 1, matrices: at(10), pivots: new Float32Array([10, 0, 0, bandWord(7, 2)]), twoSided: false, flip: false, uv2: pack, tier: 2, wind: true },
        { model: 1, primitive: 0, matrices: at(10), pivots: new Float32Array([10, 0, 0, bandWord(7, 1)]), twoSided: false, flip: false, uv2: pack, tier: 1, wind: true },
        { model: 2, primitive: 0, matrices: at(20), pivots: new Float32Array([20, 0, 0, 0]), twoSided: false, flip: false, uv2: pack },
      ],
    }
    const r = mergeRegion([job], id => models.get(id))
    const g = r.groups[0]!
    // The tier-1 piece, then the retail one (tier 0), then tier 2.
    expect([...g.pivots!].filter((_, i) => i % 4 === 3)).toEqual([29, 29, 29, 0, 0, 0, 30, 30, 30])
    expect([g.casterVertices, g.casterIndices]).toEqual([6, 6])
    expect([...g.treeW!.subarray(0, 4)]).toEqual([51, 64, 153, 204])
    // The retail piece: 6 m above its root → flex 0.6; a leaf group flutters by flex; AO 1.
    expect([g.treeW![12], g.treeW![14], g.treeW![15]]).toEqual([153, 153, 255])
    // The wind piece's UV2: the white quadrant's centre (0.75, 0.25) + 2 × slot.
    expect([...g.uvs2!.subarray(0, 2)]).toEqual([0.75, 6.25])
    const c = r.caster!
    expect([c.positions.length, c.indices.length, c.groups]).toEqual([18, 6, 1])
    expect([...c.indices]).toEqual([0, 1, 2, 3, 4, 5])
    // LOD group 3: the group's own sphere (x 10–21, y 4–8, z 0–1).
    expect(c.cull[0]).toBeCloseTo(15.5)
    expect(c.cull[3]).toBeCloseTo(Math.hypot(11, 4, 1) / 2)
    // No flags, no tier: wave 10's result (no caster, no prefix, no sroTreeW).
    const plain = mergeRegion([{ key: 'p', pivotSize: 3, proxy: false, pieces: [{ model: 2, primitive: 0, matrices: at(0), pivots: new Float32Array([0, 0, 0]), twoSided: false, flip: false, uv2: null }] }], id => models.get(id))
    expect('caster' in plain).toBe(false)
    expect(Object.keys(plain.groups[0]!).filter(k => k === 'treeW' || k.startsWith('caster'))).toEqual([])
  })
})
