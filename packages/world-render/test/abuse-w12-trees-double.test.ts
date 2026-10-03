/**
 * H-12 lens 6, "trees: double or missing" (docs/WAVE_PLAN8.md §6.7): a swapped species whose material the batch table
 * refuses (region-batch.ts `acquire`: the table full, no room for its albedo cell, a non-PBR record) is merged into a
 * material group, where "only its LOD1 draws" with the 3-float root pivot: never banded (SRO_FOL_BAND needs the 4-float
 * pivot). T12-N's trees part does not know: it still hands the placement a band slot, puts it in band 0 near the camera
 * and draws its LOD0 overlay instance, on top of the merged LOD1 that nothing collapses: the tree is drawn twice.
 *
 * A streamed NullEngine world (the stream fixture), the pine swapped to a two-tier species (batch-trees.test.ts' far.glb
 * stand-in), T12-N's real TreesNearField with a test LOD0, and a table that refuses the species' records.
 */
import {
  AssetContainer,
  Matrix,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Scene,
  TransformNode,
  Vector3,
  VertexBuffer,
  type BaseTexture,
  type Camera,
  type Mesh,
} from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  RegionStreamer,
  STREAM_DEFAULTS,
  World,
  WorldRegions,
  loadNavStreamed,
  prepareStatic,
  type CachedModel,
  type MaterialBatchRecord,
  type SidecarLite,
} from '../src/index.ts'
import { RegionBatchPart, type BatchTableEntry } from '../src/batch/region-batch.ts'
import { FOLIAGE_PIVOT_KIND } from '../src/pbr/foliage-plugin.ts'
import { BAND_NEAR, TreesNearField, placementKey, swapMatrixTo, type NearModel } from '../src/trees/index.ts'
import { BASE_URL, CX, CZ, makeFixture, settle } from './stream-fixture.ts'
import { addModel, centre } from './w10-fixture.ts'
import { BARK, FakeTables, LEAF, TREE_STATIC, WALL, isTreeMesh, type Prim } from './w12-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const SPECIES = 'pine07'
const SPECIES_GLB = `models/trees/${SPECIES}/far.glb`
const FIT: [number, number, number] = [1.5, 0.5, 1.5]
const CENTRE_ID = (CZ << 8) | CX

/** batch-trees.test.ts' far.glb stand-in: per tier a node `lod<t>` with a bark box and a leaf card. */
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
      const n = mesh.getTotalVertices()
      mesh.setVerticesData(VertexBuffer.UV2Kind, new Float32Array(n * 2).fill(0.5), false, 2)
      mesh.setVerticesData(VertexBuffer.UV3Kind, new Float32Array(n * 2).fill(0.5), false, 2)
      mesh.material = mats.get(part)!
      container.meshes.push(mesh)
    })
  }
  const tex = (part: string) => `prim\\mtrl\\nature\\common\\tree\\tre_w12_${SPECIES}_${part}.ddj`
  return {
    container,
    sidecar: {
      materials: [
        { name: `${SPECIES}_bark`, flags: 0, diffuse: [], ambient: [], texture: tex('bark'), alphaMode: 'OPAQUE' },
        { name: `${SPECIES}_leaf`, flags: 0, diffuse: [], ambient: [], texture: tex('leaf'), alphaMode: 'MASK' },
      ],
    },
  }
}

/** A retail model's container (w12-fixture's modelContainer, which it does not export). */
function retailContainer(scene: Scene, model: WorldModel, prims: Prim[]): { container: AssetContainer; sidecar: SidecarLite } {
  const container = new AssetContainer(scene)
  const root = new TransformNode(`${model.glb}#root`, scene)
  scene.removeTransformNode(root)
  container.transformNodes.push(root)
  container.rootNodes.push(root)
  const sidecar: SidecarLite = { materials: [] }
  prims.forEach((p, i) => {
    const mesh = (p.plane ? MeshBuilder.CreatePlane(`${model.index}:${p.name}`, { size: p.size ?? 1 }, scene)
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

/** A minimal species LOD0 for the overlay (w12-cross.test.ts'). */
function nearContainer(scene: Scene): NearModel {
  const container = new AssetContainer(scene)
  const root = new TransformNode('near#root', scene)
  scene.removeTransformNode(root)
  container.transformNodes.push(root)
  container.rootNodes.push(root)
  const sidecar: SidecarLite & { trees: unknown } = { materials: [], trees: { kind: 'tree', tints: [] } }
  for (const [name, mask] of [[`lod0_${SPECIES}_bark`, false], [`lod0_${SPECIES}_leaf`, true]] as const) {
    const mesh = (mask ? MeshBuilder.CreatePlane(name, { size: 3 }, scene) : MeshBuilder.CreateBox(name, { size: 0.6 }, scene)) as Mesh
    scene.removeMesh(mesh)
    mesh.parent = root
    const n = mesh.getTotalVertices()
    mesh.setVerticesData(VertexBuffer.UV2Kind, new Float32Array(n * 2).fill(0.5), false, 2)
    mesh.setVerticesData(VertexBuffer.UV3Kind, new Float32Array(n * 2).fill(0.25), false, 2)
    const src = new PBRMaterial(name, scene)
    scene.removeMaterial(src)
    if (mask) src.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    mesh.material = src
    container.meshes.push(mesh)
    container.materials.push(src)
    sidecar.materials!.push({
      name, flags: 0, diffuse: [], ambient: [], alphaMode: mask ? 'MASK' : 'OPAQUE', texture: `prim\\mtrl\\nature\\common\\tree\\tre_w12_${name}.ddj`,
    })
  }
  return { container, sidecar, path: `models/trees/${SPECIES}/near.glb` }
}

/**
 * A table that refuses the species' far.glb records (as the real MaterialTable does when full or out of albedo room).
 * The overlay's near.glb records are other records (another conversion), so the overlay can hold its slots while a
 * later region batch finds the table full.
 */
class RefusingTables extends FakeTables {
  refusedSpecies = 0

  override acquire(record: MaterialBatchRecord): BatchTableEntry | null {
    if (record.material.name.startsWith(SPECIES)) {
      this.refusedSpecies++
      return null
    }
    return super.acquire(record)
  }
}

describe('H-12 trees: a species the table refuses', () => {
  it('is drawn once near the camera: never the LOD0 overlay on top of an unbanded merged LOD1', async () => {
    const fx = makeFixture()
    const pineIdx = addModel(fx, TREE_STATIC)
    const models = fx.manifest.models
    const species = models.length
    models.push({
      ...models[pineIdx]!, index: species, source: `res\\nature\\common\\tree\\w12\\${SPECIES}.bsr#species`, glb: SPECIES_GLB, sidecar: null, kind: 'static',
    })
    models[pineIdx]!.treeSwap = { model: species, fit: FIT, tint: 0 }
    for (const p of fx.manifest.placements) if (p.models[0] === pineIdx) p.position = [p.position[0] - 9, p.position[1] + 1, p.position[2] + 15]
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const assets = new Assets(BASE_URL, fx.io)
    const nav = await loadNavStreamed(fx.manifest, assets)
    const tables = new RefusingTables()
    const parts: TreesNearField[] = []
    const world = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, {
      baseUrl: BASE_URL, minimap: false, render: 'pbr',
      parts: {
        // F-12: the test reads the merged tree arrays back (H-12 MM1 frees them on Medium otherwise)
        batch: host => new RegionBatchPart(host, { tables, worker: null, keepCpuCopies: true }),
        life: null, ocean: null, town: null,
        trees: host => {
          const t = new TreesNearField(host, {
            load: async () => {
              await settle(1)
              return nearContainer(host.scene)
            },
            kindOf: async () => 'tree',
          })
          parts.push(t)
          return t
        },
      },
    })
    cleanups.push(() => {
      world.dispose()
      scene.dispose()
      engine.dispose()
    })
    await world.water.init(assets)
    const loadModel = async (model: WorldModel): Promise<CachedModel> => {
      const { container, sidecar } = model.glb === SPECIES_GLB
        ? speciesContainer(scene, model)
        : retailContainer(scene, model, model.index === pineIdx ? [BARK, LEAF] : [WALL])
      const converted = await world.materials.convert(container, sidecar, false, { model: model.glb!, source: model.source, kind: 'static' })
      return { model, container, converted, prep: prepareStatic(container) }
    }
    const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium }, {
      now: () => 0, autoPump: false, objects: true, nav: nav.chunks, loadModel,
      disposeModel: e => {
        if (e.converted) world.materials.release(e.converted)
        e.container.dispose()
      },
      atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true },
    })
    world.stream = stream
    stream.booting = false
    const focus = centre(CX, CZ)
    for (let i = 0; i < 800; i++) {
      stream.update(focus, null)
      await settle(2)
      const s = stream.stats
      if (!s.jobs && !s.fetching && s.ready + s.failed === s.resident && s.objectsReady === s.ready) {
        stream.update(focus, null)
        if (!stream.stats.jobs) break
      }
    }
    const trees = world.trees as TreesNearField
    expect(trees).toBe(parts[0])
    expect(tables.refusedSpecies).toBeGreaterThan(0)

    // the centre region's pine, the camera 3 m from it
    const pine = fx.manifest.placements.find(p => p.models[0] === pineIdx && p.region === CENTRE_ID)!
    const m = new Float32Array(16)
    swapMatrixTo(pine, FIT, null, m, 0, new Matrix())
    const root = [m[12]!, m[13]!, m[14]!]
    const cam = { globalPosition: new Vector3(root[0]! + 3, root[1]! + 2, root[2]!) } as unknown as Camera
    for (let i = 0; i < 80 && trees.stats().overlayInstances === 0; i++) {
      trees.update(cam, 0.016)
      await settle(2)
    }
    const key = placementKey(pine.region, pine.uid)
    const overlayDraws = trees.slotOf(key) !== null && trees.bands.bytes[trees.slotOf(key)!] === BAND_NEAR && trees.stats().overlayInstances > 0

    // the merged copies of that tree that no band byte can collapse (no 4-float pivot: a material group)
    let unbanded = 0
    for (const mesh of scene.meshes) {
      if (mesh.isDisposed() || !isTreeMesh(mesh) || !mesh.isEnabled()) continue
      const pv = mesh.getVertexBuffer(FOLIAGE_PIVOT_KIND)
      const size = pv?.getSize() ?? 0
      if (size === 4) continue
      const data = mesh.getVerticesData(FOLIAGE_PIVOT_KIND)
      const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!
      const n = pos.length / 3
      for (let v = 0; v < n; v++) {
        const at = data && size ? [data[v * size]!, data[v * size + 1]!, data[v * size + 2]!] : [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!]
        if (Math.hypot(at[0]! - root[0]!, at[2]! - root[2]!) < 0.5) {
          unbanded++
          break
        }
      }
    }
    expect(overlayDraws && unbanded > 0, `the LOD0 overlay draws the tree (band 0) while ${unbanded} unbanded merged mesh(es) also hold it`).toBe(false)
  }, 120_000)
})
