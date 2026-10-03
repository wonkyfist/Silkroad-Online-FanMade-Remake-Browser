/**
 * H-10R adversarial hunt, lens "range" (the live range scale reaching the batch): Options' sight and the create screen's
 * 0.6 cap must cull a region batch like the chunks it replaces (docs/BATCHING.md §3.8 "as the chunks today", F11; the
 * region-batch.ts header: group 3 "keeps today's 96 m sub-chunks as its own groups, so its range is exactly today's").
 *
 * Each case builds the same streamed NullEngine world twice, once with today's chunks (no batching part) and once with
 * the table-mode batch, and compares what is drawn from the same camera. Every test here FAILS on e192530.
 */
import {
  AssetContainer,
  Mesh,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Scene,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type BaseTexture,
} from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
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
import { RegionBatchPart, type BatchTableEntry, type BatchTables, type GroupMaterialKey } from '../src/batch/region-batch.ts'
import { setBatchTables } from '../src/batch/index.ts'
import { BASE_URL, CX, CZ, heightOf, makeFixture, settle, type Fixture } from './stream-fixture.ts'
import { centre } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  setBatchTables(null)
})

/** A table that takes every record (one slot each). */
class Tables implements BatchTables {
  readonly lamps = true
  private next = 1
  private readonly slots = new Map<MaterialBatchRecord, BatchTableEntry>()
  acquire(record: MaterialBatchRecord): BatchTableEntry {
    let e = this.slots.get(record)
    if (!e) this.slots.set(record, (e = { slot: this.next++, layer: 0, scale: 0.5, offsetU: 0, offsetV: 0 }))
    return e
  }
  release(): void {}
  setEmissive(): void {}
  bindMaterial(_m: PBRMaterial, _k: Readonly<GroupMaterialKey>): void {}
}

/** A 1 m stone box model (its own retail material, like a glb). */
function boxModel(scene: Scene, model: WorldModel): { container: AssetContainer; sidecar: SidecarLite } {
  const container = new AssetContainer(scene)
  const root = new TransformNode(`${model.glb}#root`, scene)
  scene.removeTransformNode(root)
  container.transformNodes.push(root)
  container.rootNodes.push(root)
  const mesh = MeshBuilder.CreateBox(`${model.index}:wall`, { size: 1 }, scene) as Mesh
  scene.removeMesh(mesh)
  mesh.position.set(0, 0.5, 0)
  mesh.parent = root
  const mat = new PBRMaterial('wall', scene)
  scene.removeMaterial(mat)
  mesh.material = mat
  container.meshes.push(mesh)
  container.materials.push(mat)
  return { container, sidecar: { materials: [{ name: 'wall', flags: 0, diffuse: [], ambient: [], texture: 'res\\bldg\\wall01.ddj', alphaMode: 'OPAQUE' }] } }
}

const REGION = (CZ << 8) | CX
const GROUND = heightOf(CX, CZ)

/** Adds a static stone model with ONE placement in the centre region at (x, z), LOD group `group`. Returns its index. */
function addProp(fx: Fixture, x: number, z: number, group: 2 | 3): number {
  const m = fx.manifest
  const index = m.models.length
  const source = `res\\bldg\\china\\jangan\\prop${index}.bsr`
  m.models.push({
    index, source, glb: `models/m${index}.glb`, sidecar: null, kind: 'static', animations: [], defaultClip: null,
    lightmappedMeshes: 0, boundsMin: [-0.5, 0, -0.5], boundsMax: [0.5, 1, 0.5], bytes: 0, validatorErrors: null,
  } as WorldModel)
  m.placements.push({
    objId: index, source, models: [index], compound: false, position: [x, GROUND, z], rotation: [0, 0, 0, 1], yaw: 0,
    flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid: m.placements.length, region: REGION, group,
    inConvertedRegion: true,
  } as WorldPlacement)
  return index
}

interface Built {
  world: World
  scene: Scene
  /** Whether anything drawing model `index` is enabled (its chunk meshes; or the batch mesh that holds it). */
  drawn(index: number): boolean
}

/**
 * The streamed fixture world with the centre region's extra props, batched (`batch`) or with today's chunks. Only the
 * centre region's placements are kept, so the props are the only objects of their LOD group there.
 */
async function build(batch: boolean, props: Array<{ x: number; z: number; group: 2 | 3 }>): Promise<Built & { indices: number[] }> {
  const fx = makeFixture()
  fx.manifest.placements = fx.manifest.placements.filter(p => p.region === REGION && p.models[0] === 1)
  const indices = props.map(p => addProp(fx, p.x, p.z, p.group))
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const assets = new Assets(BASE_URL, fx.io)
  const nav = await loadNavStreamed(fx.manifest, assets)
  let part: RegionBatchPart | null = null
  const world = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, {
    baseUrl: BASE_URL, minimap: false, render: 'pbr',
    parts: { batch: batch ? host => (part = new RegionBatchPart(host, { tables: new Tables(), worker: null })) : null, life: null, ocean: null },
  })
  await world.water.init(assets)
  const loadModel = async (model: WorldModel): Promise<CachedModel> => {
    const { container, sidecar } = boxModel(scene, model)
    const converted = await world.materials.convert(container, sidecar, false, { model: model.glb!, source: model.source, kind: 'static' })
    return { model, container, converted, prep: model.kind === 'static' ? prepareStatic(container) : null }
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
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  if (batch) expect(part).not.toBeNull()
  const drawn = (index: number): boolean => {
    const own = scene.meshes.filter(m => !m.isDisposed() && m.name.startsWith(`${index}:wall@`))
    if (!batch) return own.length > 0 && own.some(m => m.isEnabled(false))
    // Batched: the region's batch meshes that hold this model's vertices (every prop here is the only one at its spot).
    const p = [...world.objects.regionBatches.values()].find(b => b.region === REGION)
    if (!p) throw new Error('the centre region has no batch')
    const at = props[indices.indexOf(index)]!
    return p.meshes.some(m => m.isEnabled(false) && holds(m, at.x, at.z))
  }
  return { world, scene, drawn, indices }
}

/** Whether a merged mesh has a vertex within 1 m of (x, z) in xz. */
function holds(m: AbstractMesh, x: number, z: number): boolean {
  const pos = m.getVerticesData('position')
  if (!pos) return false
  for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i]! - x) < 1 && Math.abs(pos[i + 2]! - z) < 1) return true
  return false
}

describe('H-10R range: the live scale must cull a batch like the chunks it replaces', () => {
  it('group 3 (48 m × scale): two props in one 96 m sub-chunk are drawn from 78 m away by the batch, hidden by the chunks', async () => {
    // The centre region spans x 0..192, z 0..-192; its south-west sub-chunk is x 0..96, z 0..-96. Two different lion
    // models sit at opposite corners of it; the camera stands 78 m from each (past 48 m), off the middle of their
    // diagonal. Today each model's sub-chunk chunk has its own 1 m box and both are hidden; the batch merges both
    // models into one sub-chunk mesh whose box spans the diagonal (radius ≈ 61 m), so it shows.
    const props = [{ x: 5, z: -5, group: 3 as const }, { x: 90, z: -90, group: 3 as const }]
    const cam = new Vector3(82.5, GROUND + 1, -12.5)
    const chunks = await build(false, props)
    chunks.world.objects.update(cam, true)
    const batched = await build(true, props)
    batched.world.objects.update(cam, true)
    const today = chunks.indices.map(i => chunks.drawn(i))
    const now = batched.indices.map(i => batched.drawn(i))
    expect(today).toEqual([false, false])
    // FAILS: [true, true] — the stone lions pop in at 78 m (162 % of group 3's 48 m range).
    expect(now).toEqual(today)
  })

  it('group 2 at the create cap 0.6 (121 m): a region whose every object is 140+ m away is drawn by the batch; even sight 0.1 cannot cull it', async () => {
    // Three group-2 props of the centre region: its south-west and north-east corners and its middle. The camera is
    // 140 m from the middle and ≈ 190 m from the corners: every chunk is past 202 × 0.6 = 121 m. The batch's group-2
    // mesh spans the whole region (radius ≈ 129 m), so `distance − radius` is ≈ 11 m.
    const props = [{ x: 5, z: -5, group: 2 as const }, { x: 187, z: -187, group: 2 as const }, { x: 96, z: -96, group: 2 as const }]
    const cam = new Vector3(96 + 99, GROUND + 1, -96 + 99)
    const chunks = await build(false, props)
    chunks.world.objects.setRangeScale(0.6)
    chunks.world.objects.update(cam, true)
    const batched = await build(true, props)
    batched.world.objects.setRangeScale(0.6)
    batched.world.objects.update(cam, true)
    expect(chunks.indices.map(i => chunks.drawn(i))).toEqual([false, false, false])
    // FAILS: the create screen's cap does not cull the region (3 props drawn at 140–190 m).
    expect(batched.indices.map(i => batched.drawn(i))).toEqual([false, false, false])
    // The narrowest possible scale (0.1 → 20 m) still draws it: the scale barely reaches a region within ≈ 150 m.
    batched.world.objects.setRangeScale(0.1)
    expect(batched.indices.map(i => batched.drawn(i))).toEqual([false, false, false])
  })

  it('the viewer\'s LOD toggle (WorldObjects.setLod(false): no draw ranges) never reaches the batch', async () => {
    // apps/viewer/src/world/main.ts binds ui.lod to objects.setLod. With it off the chunks draw at any distance; the
    // batcher has no setLod and keeps culling, so the viewer shows the batched world with ranges and the rest without.
    const props = [{ x: 96, z: -96, group: 2 as const }]
    const far = new Vector3(96 + 600, GROUND + 1, -96)
    const chunks = await build(false, props)
    chunks.world.objects.setLod(false)
    chunks.world.objects.update(far, true)
    const batched = await build(true, props)
    batched.world.objects.setLod(false)
    batched.world.objects.update(far, true)
    expect(chunks.drawn(chunks.indices[0]!)).toBe(true)
    // FAILS: false — the batch mesh stays range-culled with LOD off.
    expect(batched.drawn(batched.indices[0]!)).toBe(true)
  })
})
