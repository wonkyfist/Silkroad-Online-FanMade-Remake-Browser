/**
 * Wave 10r adversarial hunt, the BATCHING.md H-BT lenses (docs/BATCHING.md §6.2 H-BT, §3.2, §3.8, §8): each test here
 * states what the spec promises and fails while the product breaks it.
 *
 * - Lens 10 (group-3 props visible beyond 48 m × scale): the region batch merges every model of a 96 m sub-chunk into
 *   one group mesh and range-tests that mesh's bounding sphere, so a small prop shares the sphere of every other prop
 *   of its sub-chunk. Today's chunks are per (model, sub-chunk), so the batch's "its range is exactly today's"
 *   (region-batch.ts file comment, §3.8) does not hold once two different models share a sub-chunk.
 * - Lens 8 (atlas mip bleeding on tiling walls at distance): the table's albedo sample (SRO_TABLE, textureGrad /
 *   textureSampleGrad) has no LOD clamp, so it may read every level of the atlas page chain (ATLAS_LEVELS); the wrap
 *   gutter (`max(2, side / 64)` texels at level 0) is under half a texel from a level on, and the bilinear tap of a UV
 *   at the cell's inner edge then reads the neighbouring cell (§8's risk row: "clamp the LOD per cell").
 */
import {
  AssetContainer,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type BaseTexture,
  type Mesh,
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
import { ATLAS_LEVELS, ATLAS_PAGE, cellTexel } from '../src/batch/atlas.ts'
import { atlasMaxLod, cellShape } from '../src/pbr/decode-core.ts'
import { TABLE_ATLAS_PAGE, surfaceFragmentCode } from '../src/pbr/surface-plugin.ts'
import { BASE_URL, CX, CZ, makeFixture, settle, type Fixture } from './stream-fixture.ts'
import { centre } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

// ---- a streamed NullEngine world with a region batch (region-batch.test.ts' harness, trimmed) ----------------------

class FakeTables implements BatchTables {
  readonly lamps = true
  private readonly refs = new Map<MaterialBatchRecord, { entry: BatchTableEntry; n: number }>()
  private next = 1
  acquire(record: MaterialBatchRecord): BatchTableEntry | null {
    let e = this.refs.get(record)
    if (!e) {
      e = { entry: { slot: this.next++, layer: 0, scale: 0.5, offsetU: 0, offsetV: 0 }, n: 0 }
      this.refs.set(record, e)
    }
    e.n++
    return e.entry
  }
  release(entry: BatchTableEntry): void {
    for (const [r, e] of this.refs) if (e.entry === entry && --e.n <= 0) this.refs.delete(r)
  }
  setEmissive(): void {}
  bindMaterial(_m: PBRMaterial, _k: Readonly<GroupMaterialKey>): void {}
}

function boxModel(scene: Scene, model: WorldModel): { container: AssetContainer; sidecar: SidecarLite } {
  const container = new AssetContainer(scene)
  const root = new TransformNode(`${model.glb}#root`, scene)
  root.rotationQuaternion = Quaternion.Identity()
  scene.removeTransformNode(root)
  container.transformNodes.push(root)
  container.rootNodes.push(root)
  // A small prop: a 1 m box standing on the ground.
  const mesh = MeshBuilder.CreateBox(`${model.index}:prop`, { size: 1 }, scene) as Mesh
  scene.removeMesh(mesh)
  mesh.position.set(0, 0.5, 0)
  mesh.parent = root
  const mat = new PBRMaterial(`prop${model.index}`, scene)
  scene.removeMaterial(mat)
  mesh.material = mat
  container.meshes.push(mesh)
  container.materials.push(mat)
  return { container, sidecar: { materials: [{ name: `prop${model.index}`, flags: 0, diffuse: [], ambient: [], texture: 'res\\bldg\\wall01.ddj', alphaMode: 'OPAQUE' }] } }
}

async function batchWorld(edit: (fx: Fixture) => void) {
  const fx = makeFixture()
  edit(fx)
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const assets = new Assets(BASE_URL, fx.io)
  const nav = await loadNavStreamed(fx.manifest, assets)
  const parts: RegionBatchPart[] = []
  const world = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, {
    baseUrl: BASE_URL, minimap: false, render: 'pbr',
    parts: {
      batch: host => {
        const p = new RegionBatchPart(host, { tables: new FakeTables(), worker: null })
        parts.push(p)
        return p
      },
      life: null, ocean: null,
    },
  })
  await world.water.init(assets)
  const loadModel = async (model: WorldModel): Promise<CachedModel> => {
    const { container, sidecar } = boxModel(scene, model)
    const converted = await world.materials.convert(container, sidecar, false, { model: model.glb!, source: model.source, kind: model.kind === 'skinned' ? 'clone' : 'static' })
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
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { fx, world, parts, run }
}

/** Adds a static model with one group-3 placement at each of `spots` (glTF x, z) in the centre region. */
function addProp(fx: Fixture, source: string, spots: Array<[number, number]>): number {
  const m = fx.manifest
  const index = m.models.length
  m.models.push({
    index, source, glb: `models/m${index}.glb`, sidecar: null, kind: 'static', animations: [], defaultClip: null,
    lightmappedMeshes: 0, boundsMin: [-0.5, 0, -0.5], boundsMax: [0.5, 1, 0.5], bytes: 0, validatorErrors: null,
  } as WorldModel)
  const id = (CZ << 8) | CX
  const r = m.regions.find(x => x.id === id)!
  for (const [x, z] of spots) {
    m.placements.push({
      objId: index, source, models: [index], compound: false, position: [x, r.bounds.min[1], z], rotation: [0, 0, 0, 1],
      yaw: 0, flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid: m.placements.length, region: id, group: 3,
      inConvertedRegion: true,
    } as WorldPlacement)
  }
  return index
}

// ---- lens 10 ------------------------------------------------------------------------------------------------------

describe('H-BT lens 10: group-3 props are never drawn beyond 48 m × scale', () => {
  it('two different props in one 96 m sub-chunk: each stays hidden when the camera is over 48 m from both', async () => {
    let ox = 0, oz = 0, y = 0
    const s = await batchWorld(fx => {
      const r = fx.manifest.regions.find(x => x.id === ((CZ << 8) | CX))!
      ox = r.origin[0]
      oz = r.origin[2]
      y = r.bounds.min[1]
      // Both in the region's south-west 96 m sub-chunk (objects.ts' cell 0), 85 m apart on its diagonal; two models,
      // so today's chunks are two (one per model), each with its own 1 m sphere.
      addProp(fx, 'res\\bldg\\china\\jangan\\lion01.bsr', [[ox + 5, oz - 5]])
      addProp(fx, 'res\\bldg\\china\\jangan\\stone_lantern01.bsr', [[ox + 90, oz - 90]])
    })
    await s.run()
    const part = s.parts[0]!
    const batch = [...s.world.objects.regionBatches.values()].find(b => b.region === ((CZ << 8) | CX))!
    const g3 = batch.meshes.filter(m => m.name.includes(':3:'))
    // The two props merged into one group-3 mesh of the sub-chunk (the table's one opaque group).
    expect(g3).toHaveLength(1)
    const props: Array<[number, number]> = [[ox + 5, oz - 5], [ox + 90, oz - 90]]
    // The camera 70 m off the diagonal's midpoint, at right angles to it: 92 m from either prop.
    const mid = [(props[0]![0] + props[1]![0]) / 2, (props[0]![1] + props[1]![1]) / 2]
    const cam = new Vector3(mid[0]! + 70 / Math.SQRT2, y + 1.7, mid[1]! + 70 / Math.SQRT2)
    const nearest = Math.min(...props.map(([x, z]) => Math.hypot(x - cam.x, z - cam.z)))
    expect(nearest).toBeGreaterThan(90)
    part.update(cam)
    // Today each prop's chunk is hidden here (distance − its ~1 m radius > 48 m); the batch must not draw them.
    const shown = (m: AbstractMesh) => m.isEnabled(false)
    expect(g3.filter(shown).map(m => m.name)).toEqual([])
  })
})

// ---- lens 8 -------------------------------------------------------------------------------------------------------

describe('H-BT lens 8: no atlas mip bleeding on tiling textures at distance', () => {
  // Fixed (RA-1 / BT-L8): the table shader clamps its albedo and NRAO gradients per cell (sroGradK) so the level stays
  // at or below decode-core atlasMaxLod. This case asserted the missing clamp; it now asserts the clamp in both languages.
  it('the albedo and NRAO samples clamp their gradients per cell (sroGradK), in both languages', () => {
    const w = JSON.stringify(surfaceFragmentCode('wgsl')), g = JSON.stringify(surfaceFragmentCode('glsl'))
    expect(w).toContain('textureSampleGrad(sroAlbArr')
    expect(g).toContain('textureGrad(sroAlbArr')
    expect(w.match(/sroGradK\(/g)?.length).toBe(3)
    expect(g.match(/sroGradK\(/g)?.length).toBe(3)
    expect(TABLE_ATLAS_PAGE).toBe(ATLAS_PAGE)
    expect(ATLAS_LEVELS).toBe(6)
  })

  it('at every level the shader can read, a bilinear tap at a cell\'s inner edge stays inside the cell', () => {
    const leaks: string[] = []
    // The texture sizes of the jangan-fields albedo set: 32 … 1024 (cells ≥ 32, ≤ 64 kept at 2×).
    for (const side of [16, 32, 64, 128, 256, 512, 1024]) {
      const shape = cellShape(side, side, ATLAS_PAGE, ATLAS_LEVELS)
      // A cell away from the page edge (x = one cell in), where a neighbour cell lies to its left.
      const cell = { array: 0, layer: 0, x: shape.width, y: shape.height, shape }
      const t = cellTexel(cell as Parameters<typeof cellTexel>[0], ATLAS_PAGE)
      // The shader's clamp (sroGradK, from the inner uv scale) is decode-core's atlasMaxLod.
      const inner = Math.min(t.uScale, t.vScale) * TABLE_ATLAS_PAGE
      expect(Math.max(2, Math.floor(Math.log2(inner) + 0.05) - 5), `${side}²`).toBe(atlasMaxLod(shape))
      for (let level = 0; level < ATLAS_LEVELS && level <= atlasMaxLod(shape); level++) {
        const size = ATLAS_PAGE >> level
        // UV fract 0 at the inner edge (the shader: sroA.yz + fract(uv) × scale): the texel coordinate − 0.5.
        const tx = t.u0 * size - 0.5
        const first = Math.floor(tx)
        const weight = tx - first
        const cellFirst = (cell.x >> level)
        // The left tap (weight 1 − frac) lands left of the cell: a neighbour texel blended in.
        if (first < cellFirst && 1 - weight > 1e-6) leaks.push(`${side}² cell (${shape.width} wide, gutter ${shape.gutterX}) at level ${level}: ${((1 - weight) * 100).toFixed(0)} % of the neighbour`)
      }
    }
    expect(leaks).toEqual([])
  })
})
