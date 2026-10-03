/**
 * W11-S, the world-render seams of wave 11 (docs/WAVE_PLAN7.md §4.3; docs/TOWN_LIFE.md §2.3, §4, §5.1, §5.3, §7.5, §8.3):
 *
 * 1. The town part: `World.town` is made on the PBR path only (null on Classic: the Low guard), updated after the life
 *    part, disposed before it, made again by `setRenderMode` (PBR → Classic → PBR leaves no town mesh), and takes the
 *    Town life level (`townLife`, `setTownLife`).
 * 2. The batch: the region claim refuses a 'town' mesh; with no cloth record the `+sheen` groups merge as today (no
 *    pivot, no plugin); a cloth record gives the group a 4-float per-piece pivot (pin, height, kind, phase) with the
 *    same geometry and draws, and the reclass moves a material into the cloth class.
 * 3. The shader slot: the foliage code with SRO_CLOTH_WIND off is HEAD's, byte for byte, in both languages; only a cloth
 *    plugin carries the slot, every line of it under `#ifdef SRO_CLOTH_WIND`; it switches on a mesh with the cloth pivot.
 * 4. Life: the `float` landing (bob only, no peck-hops); without it a flock moves exactly as before.
 * 5. Post and water: `setTemporalOverride('x', 'none')` is a no-op, 'msaa4' swaps TAA for MSAA ×4 on a TAA preset only;
 *    with no ripple point and no profile the water material and its strings are HEAD's; points and the 'town' profile
 *    add the town plugin and the region's vertex colour b.
 */
import {
  AssetContainer,
  ArcRotateCamera,
  InternalTexture,
  InternalTextureSource,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Quaternion,
  RawTexture,
  Scene,
  ShaderLanguage,
  TransformNode,
  Vector3,
  Vector4,
  VertexBuffer,
  type AbstractMesh,
  type BaseTexture,
  type Camera,
  type Mesh,
} from '@babylonjs/core'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GRID } from '../../convert/src/world/format.ts'
import type { WorldModel } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  CLEAR_RENDER_WEATHER,
  RENDER_PRESETS,
  RegionStreamer,
  STREAM_DEFAULTS,
  SRO_WATER_PLUGIN,
  StubTown,
  TOWN_TAG,
  World,
  WorldRegions,
  WaterRenderer,
  isBatchableMesh,
  isTownMesh,
  loadNavStreamed,
  prepareStatic,
  type BatchFactory,
  type CachedModel,
  type GpuInfo,
  type MaterialBatchRecord,
  type RegionData,
  type RenderPath,
  type RenderPreset,
  type SidecarLite,
  type TownConfig,
  type TownPart,
  type WaterRenderSource,
  type WorldRegions as WorldRegionsT,
  WorldRender,
} from '../src/index.ts'
import { UNBATCHED_TAGS } from '../src/batch/types.ts'
import { TownLife, schedulePlan, townPartWith } from '../src/town/index.ts'
import { stubCrowdAssets } from '../src/town/crowd.ts'
import type { TownFactory } from '../src/town/types.ts'
import type { TownFile } from '../../shared/src/town.ts'
import { CLOTH_PIVOT_SIZE, RegionBatchPart, clothPivots, type BatchTableEntry, type BatchTables, type GroupMaterialKey } from '../src/batch/region-batch.ts'
import { clothKindCode, clothOf, withManifestCloth } from '../src/materials.ts'
import { FLOAT_BOB_M, Flock } from '../src/life/flock.ts'
import { LifeBirds, birdSpeciesOf } from '../src/life/birds.ts'
import { FOLIAGE_MIN_BREEZE, FOLIAGE_PIVOT_KIND, FoliageShared, SroFoliagePlugin, clothFoliageCode, foliageCode, foliagePluginOf } from '../src/pbr/foliage-plugin.ts'
import { SroSurfacePlugin, SurfaceShared } from '../src/pbr/surface-plugin.ts'
import { HeightFog, attachFogPlugin } from '../src/pbr/fog-plugin.ts'
import { waterFragmentCode } from '../src/pbr/water-plugin.ts'
import { RIPPLE_POINTS_MAX, SRO_WATER_TOWN_PLUGIN, rippleTilt, waterTownFragmentCode, waterTownPluginOf } from '../src/pbr/water-town-plugin.ts'
import { installRenderPost, planPost, renderPostOf } from '../src/render/post.ts'
import {
  HEAD_FOLIAGE_FRAGMENT_GLSL_W10R,
  HEAD_FOLIAGE_FRAGMENT_WGSL_W10R,
  HEAD_FOLIAGE_VERTEX_GLSL_W10R,
  HEAD_FOLIAGE_VERTEX_WGSL_W10R,
  HEAD_WATER_FRAGMENT_GLSL_W10R,
  HEAD_WATER_FRAGMENT_WGSL_W10R,
} from './golden/head-w10r-plugins.ts'
import { BASE_URL, CX, CZ, makeFixture, settle, type Fixture } from './stream-fixture.ts'
import { FakeBatch, FakeLife, addModel, centre, w10World, type W10Setup } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

async function world(o: Parameters<typeof w10World>[0] = {}): Promise<W10Setup> {
  const s = await w10World(o)
  cleanups.push(s.dispose)
  return s
}

// ---- 1. the town part ---------------------------------------------------------------------------------------------

/** A town part that draws one tagged box and records its calls (TL-C's stand-in). */
class FakeTown implements TownPart {
  enabled = true
  readonly configs: TownConfig[] = []
  readonly enables: boolean[] = []
  readonly alarms: Array<[number, number]> = []
  clock: (() => number) | null = null
  disposed = false
  /** Whether the life part was already gone when this one was disposed. */
  lifeGoneAtDispose: boolean | null = null
  readonly mesh: Mesh

  constructor(readonly world: World, readonly order: string[]) {
    this.mesh = MeshBuilder.CreateBox('townFolk', { size: 1 }, world.scene) as Mesh
    this.mesh.metadata = { sroWorld: TOWN_TAG }
    this.mesh.isPickable = false
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.enables.push(on)
  }

  setClock(fn: (() => number) | null): void {
    this.clock = fn
  }

  setThreats(): void {}

  configure(c: TownConfig): void {
    this.configs.push(c)
  }

  alarm(nowS: number, sec: number): void {
    this.alarms.push([nowS, sec])
  }

  update(_camera: Camera | null, _dt: number): void {
    this.order.push('town')
  }

  meshes(): AbstractMesh[] {
    return this.disposed ? [] : [this.mesh]
  }

  stats(): Readonly<Record<string, number>> {
    return { folk: 1 }
  }

  dispose(): void {
    this.lifeGoneAtDispose = (this.world.life as FakeLife | null)?.disposed ?? true
    this.disposed = true
    this.mesh.dispose()
  }
}

function townFactory() {
  const order: string[] = []
  const made: FakeTown[] = []
  const lives: FakeLife[] = []
  return {
    order, made, lives,
    parts: {
      batch: null,
      ocean: null,
      life: () => {
        const l = new FakeLife(order)
        lives.push(l)
        return l
      },
      town: vi.fn(({ world: w }: { world: World }) => {
        const t = new FakeTown(w, order)
        made.push(t)
        return t
      }),
    },
  }
}

const townMeshes = (scene: Scene) => scene.meshes.filter(m => isTownMesh(m) && !m.isDisposed())

describe('the town part (World.town, D2): PBR only, after the wildlife, made again by the path switch', () => {
  it('Classic (Low): no town part, never asked for one (the Low guard); PBR: one, at Town life Full', async () => {
    const f = townFactory()
    const classic = await world({ render: 'classic', parts: f.parts })
    expect(classic.world.town).toBeNull()
    expect(f.parts.town).not.toHaveBeenCalled()
    expect(townMeshes(classic.scene)).toHaveLength(0)

    const g = townFactory()
    const s = await world({ render: 'pbr', parts: g.parts })
    expect(s.world.town).toBe(g.made[0])
    expect(s.world.townLife).toBe('full')
    expect(g.made[0]!.configs).toEqual([{ counts: 1 }])
    expect(g.made[0]!.enables).toEqual([true])
  })

  it('the default part is TL-C\'s (no townsfolk on a world without a town: no meshes; keeps its wiring); a factory that throws leaves none', async () => {
    // TL-C landed: the default is TownLife (town/index.ts); the seam's stub stays exported for the seam tests.
    const s = await world({ render: 'pbr', parts: { batch: null, life: null, ocean: null } })
    const t = s.world.town as TownLife
    expect(t).toBeInstanceOf(TownLife)
    expect(t.plan).toBeNull()
    expect(t.meshes()).toEqual([])
    t.setClock(() => 1.8e9)
    t.alarm(1.8e9, 60)
    t.configure({ counts: 0.5, noFolk: { x: 1, z: 2, r: 3 } })
    expect(t.now()).toBe(1.8e9)
    expect(t.stats().enabled).toBe(1)
    const stub = new StubTown({ scene: s.scene, world: s.world })
    stub.setClock(() => 1.8e9)
    stub.alarm(1.8e9, 60)
    stub.configure({ counts: 0.5, noFolk: { x: 1, z: 2, r: 3 } })
    expect([stub.clock!(), stub.alarmUntilS, stub.config.counts, stub.config.noFolk]).toEqual([1.8e9, 1.8e9 + 60, 0.5, { x: 1, z: 2, r: 3 }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = await world({ render: 'pbr', parts: { batch: null, life: null, ocean: null, town: () => { throw new Error('boom') } } })
    expect(bad.world.town).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('updates after the wildlife, every frame', async () => {
    const f = townFactory()
    const s = await world({ render: 'pbr', parts: f.parts })
    f.order.length = 0
    s.world.update(null, centre(CX, CZ))
    s.world.update(null, centre(CX, CZ))
    expect(f.order).toEqual(['life', 'town', 'life', 'town'])
  })

  it('PBR → Classic → PBR: the town goes (before the wildlife) and leaves no mesh, then a new one comes (after it)', async () => {
    const f = townFactory()
    const s = await world({ render: 'pbr', parts: f.parts })
    await s.run()
    expect(townMeshes(s.scene)).toHaveLength(1)
    s.world.setTownLife('low')
    s.world.setRenderMode('classic')
    await s.run()
    expect(s.world.town).toBeNull()
    expect(s.world.life).toBeNull()
    expect(f.made[0]!.disposed).toBe(true)
    expect(f.made[0]!.lifeGoneAtDispose).toBe(false)
    expect(townMeshes(s.scene)).toHaveLength(0)
    s.world.setRenderMode('pbr')
    await s.run()
    expect(f.made).toHaveLength(2)
    expect(s.world.town).toBe(f.made[1])
    // The new part was made with the wildlife there, and takes the level asked for meanwhile.
    expect(f.lives).toHaveLength(2)
    expect(f.made[1]!.configs).toEqual([{ counts: 0.5 }])
    expect(townMeshes(s.scene)).toEqual([f.made[1]!.mesh])
    s.dispose()
    expect(f.made[1]!.disposed).toBe(true)
    expect(f.made[1]!.lifeGoneAtDispose).toBe(false)
    expect(townMeshes(s.scene)).toHaveLength(0)
  })

  it('Town life: Low halves the counts, Off hides the part (it stays), Full shows it again', async () => {
    const f = townFactory()
    const s = await world({ render: 'pbr', parts: f.parts })
    const t = f.made[0]!
    s.world.setTownLife('low')
    s.world.setTownLife('off')
    s.world.setTownLife('full')
    expect(t.configs).toEqual([{ counts: 1 }, { counts: 0.5 }, { counts: 1 }])
    expect(t.enables).toEqual([true, true, false, true])
    expect(s.world.town).toBe(t)
  })
})

// ---- 2. the batch: the 'town' tag, the cloth pivots ---------------------------------------------------------------

describe("the batch never takes a 'town' mesh (TOWN_LIFE §8.3)", () => {
  it("'town' is an unbatched tag; a model whose mesh is tagged 'town' is never offered: it places as chunks", async () => {
    expect(UNBATCHED_TAGS).toEqual(['scatter', 'life', 'ocean', 'town'])
    expect(isBatchableMesh({ metadata: { sroWorld: 'town' } })).toBe(false)
    let tagged = -1
    const made: FakeBatch[] = []
    const factory: BatchFactory = host => {
      const b = new FakeBatch(host.scene)
      made.push(b)
      return b
    }
    const s = await world({
      parts: { batch: factory, life: null, ocean: null, town: null },
      edit: fx => {
        tagged = addModel(fx, 'res\\test\\townfolk.bsr')
      },
      tag: m => (m.index === tagged ? TOWN_TAG : null),
    })
    await s.run()
    expect(made[0]!.offered.length).toBeGreaterThan(0)
    expect(made[0]!.offered).not.toContain(tagged)
    expect(s.world.objects.stats.chunks).toBe(s.stream.stats.ready)
  })
})

/** One primitive of a fixture model (region-batch.test.ts' shape) with an optional cloth reclass. */
interface Prim {
  name: string
  texture: string
  size?: number
  cloth?: 'hanging' | 'awning' | 'tent'
  clothPin?: [number, number]
}

const WALL: Prim = { name: 'wall', texture: 'res\\bldg\\wall01.ddj' }
const CLOTH: Prim = { name: 'awning', texture: 'res\\bldg\\cloth01.ddj', size: 0.7 }
const STALL: Prim = { name: 'stall', texture: 'res\\bldg\\stall02.ddj', size: 0.5 }

class Tables implements BatchTables {
  lamps = true
  readonly bound: Array<{ material: PBRMaterial; key: GroupMaterialKey }> = []
  private next = 1
  private readonly slots = new Map<MaterialBatchRecord, BatchTableEntry>()
  acquire(record: MaterialBatchRecord): BatchTableEntry | null {
    let e = this.slots.get(record)
    if (!e) this.slots.set(record, (e = { slot: this.next++, layer: 0, scale: 0.5, offsetU: 0.5, offsetV: 0 }))
    return e
  }

  release(): void {}
  setEmissive(): void {}
  bindMaterial(material: PBRMaterial, key: Readonly<GroupMaterialKey>): void {
    this.bound.push({ material, key: { ...key } })
  }
}

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
    const mesh = MeshBuilder.CreateBox(`${model.index}:${p.name}`, { size: p.size ?? 1 }, scene) as Mesh
    scene.removeMesh(mesh)
    mesh.position.set(i * 0.5, 0.5 + i * 0.25, 0)
    mesh.parent = root
    const src = new PBRMaterial(p.name, scene)
    scene.removeMaterial(src)
    mesh.material = src
    container.meshes.push(mesh)
    container.materials.push(src)
    sidecar.materials!.push({
      name: p.name, flags: 0, diffuse: [], ambient: [], texture: p.texture, alphaMode: 'OPAQUE',
      ...(p.cloth ? { cloth: p.cloth } : {}), ...(p.clothPin ? { clothPin: p.clothPin } : {}),
    })
  })
  return { container, sidecar }
}

async function clothWorld(prims: (m: WorldModel) => Prim[], town: TownFactory | null = null) {
  const fx: Fixture = makeFixture()
  addModel(fx, 'res\\bldg\\china\\jangan\\cj_streetstall_02.bsr')
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const assets = new Assets(BASE_URL, fx.io)
  const nav = await loadNavStreamed(fx.manifest, assets)
  const tables = new Tables()
  const parts: RegionBatchPart[] = []
  const w = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, {
    baseUrl: BASE_URL, minimap: false, render: 'pbr',
    parts: { batch: host => { const p = new RegionBatchPart(host, { tables, worker: null }); parts.push(p); return p }, life: null, ocean: null, town },
  })
  await w.water.init(assets)
  const loadModel = async (model: WorldModel): Promise<CachedModel> => {
    const { container, sidecar } = modelContainer(scene, model, prims(model))
    const converted = await w.materials.convert(container, sidecar, false, { model: model.glb!, source: model.source, kind: model.kind === 'skinned' ? 'clone' : 'static' })
    return { model, container, converted, prep: model.kind === 'static' ? prepareStatic(container) : null }
  }
  const stream = new RegionStreamer(w, { ...STREAM_DEFAULTS.medium }, {
    now: () => 0, autoPump: false, objects: true, nav: nav.chunks, loadModel,
    disposeModel: e => {
      if (e.converted) w.materials.release(e.converted)
      e.container.dispose()
    },
    atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true },
  })
  w.stream = stream
  stream.booting = false
  for (let i = 0; i < 800; i++) {
    stream.update(centre(CX, CZ), null)
    await settle(2)
    const st = stream.stats
    if (!st.jobs && !st.fetching && st.ready + st.failed === st.resident && st.objectsReady === st.ready) {
      stream.update(centre(CX, CZ), null)
      if (!stream.stats.jobs) break
    }
  }
  cleanups.push(() => {
    w.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { scene, world: w, part: parts[0]!, tables, regions: stream.stats.ready }
}

/** A group mesh's arrays (geometry only), keyed by its label and first vertex (owners differ between worlds). */
function geometryShape(meshes: readonly AbstractMesh[]): Map<string, Record<string, number[]>> {
  const out = new Map<string, Record<string, number[]>>()
  for (const m of meshes) {
    const pos = m.getVerticesData(VertexBuffer.PositionKind)!
    const label = m.name.split(':').slice(2).join(':')
    const key = `${label}@${[pos[0], pos[1], pos[2]].map(v => v!.toFixed(4)).join(',')}`
    out.set(key, {
      positions: [...pos], normals: [...m.getVerticesData(VertexBuffer.NormalKind)!], uv: [...(m.getVerticesData(VertexBuffer.UVKind) ?? [])],
      uv2: [...(m.getVerticesData(VertexBuffer.UV2Kind) ?? [])], indices: [...(m.getIndices() ?? [])],
    })
  }
  return out
}

const sheenOf = (s: { part: RegionBatchPart; tables: Tables }) =>
  s.part.meshes().filter(m => s.tables.bound.find(b => b.material === m.material)?.key.sheen)

describe('cloth in the +sheen groups (TOWN_LIFE §5.1, F1): a per-piece pivot from the cloth record, else today', () => {
  const prims = (cloth: Prim, stall: Prim) => (m: WorldModel) => (m.index === 2 ? [cloth, stall] : [WALL])

  it('no cloth record: no pivot, no foliage plugin on the sheen material, no cloth group', async () => {
    const s = await clothWorld(prims(CLOTH, STALL))
    expect(s.part.stats.clothGroups).toBe(0)
    const sheen = sheenOf(s)
    expect(sheen.length).toBe(s.regions)
    for (const m of s.part.meshes()) expect(m.isVerticesDataPresent(FOLIAGE_PIVOT_KIND)).toBe(false)
    expect(foliagePluginOf(sheen[0]!.material!)).toBeNull()
    expect(s.world.materials.materials.every(m => !s.world.materials.batchRecord(m)?.cloth)).toBe(true)
  })

  it('a cloth record adds the 4-float pivot (pin at the top, the height, kind, phase) with the same geometry and draws', async () => {
    const today = await clothWorld(prims(CLOTH, STALL))
    const s = await clothWorld(prims({ ...CLOTH, cloth: 'hanging' }, STALL))
    expect(s.part.meshes().length).toBe(today.part.meshes().length)
    expect(geometryShape(s.part.meshes())).toEqual(geometryShape(today.part.meshes()))
    expect(s.part.stats.clothGroups).toBe(s.regions)
    for (const m of sheenOf(s)) {
      expect(m.getVertexBuffer(FOLIAGE_PIVOT_KIND)!.getSize()).toBe(CLOTH_PIVOT_SIZE)
      const pv = m.getVerticesData(FOLIAGE_PIVOT_KIND)!
      const pos = m.getVerticesData(VertexBuffer.PositionKind)!
      for (let v = 0; v < pos.length / 3; v++) {
        const [pin, h, kind, ph] = [pv[v * 4]!, pv[v * 4 + 1]!, pv[v * 4 + 2]!, pv[v * 4 + 3]!]
        expect(kind).toBe(1)
        expect(pos[v * 3 + 1]!).toBeLessThanOrEqual(pin + 1e-4)
        expect(pos[v * 3 + 1]!).toBeGreaterThanOrEqual(pin - h - 1e-4)
        expect(h).toBeCloseTo(0.7, 4)
        expect(ph).toBeGreaterThanOrEqual(0)
        expect(ph).toBeLessThan(Math.PI * 2)
      }
      // The group material carries the cloth slot (one plugin, shared by every region's sheen group).
      const plugin = foliagePluginOf(m.material!)!
      expect(plugin.cloth).toBe(true)
      expect(plugin.leaf).toBe(false)
      expect(plugin.breeze).toBe(FOLIAGE_MIN_BREEZE)
    }
    // Non-sheen groups stay without a pivot.
    for (const m of s.part.meshes()) if (!sheenOf(s).includes(m)) expect(m.isVerticesDataPresent(FOLIAGE_PIVOT_KIND)).toBe(false)
  })

  it('the reclass moves a material into the cloth class (its pieces join the sheen group with their kind; the rest sway 0)', async () => {
    const s = await clothWorld(prims(CLOTH, { ...STALL, cloth: 'awning' }))
    const stall = s.world.materials.materials.map(m => s.world.materials.batchRecord(m)).find(r => r?.name === 'stall')!
    expect(stall.cls).toBe('cloth')
    expect(stall.cloth).toEqual({ kind: 'awning', pin: null })
    for (const m of sheenOf(s)) {
      const pv = m.getVerticesData(FOLIAGE_PIVOT_KIND)!
      const kinds = new Set<number>()
      for (let v = 0; v < pv.length / 4; v++) kinds.add(pv[v * 4 + 2]!)
      expect([...kinds].sort()).toEqual([0, 2])
    }
  })

  it('clothPivots: the pin (top, base, or the converter\'s), the height, the kind code and a phase per piece', () => {
    const box = [-1, 0, -0.5, 1, 2, 0.5]
    // T(x, y, z) R(yaw about Y) in Babylon's layout.
    const at = (x: number, y: number, z: number, yaw = 0) => {
      const c = Math.cos(yaw), s = Math.sin(yaw)
      return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1])
    }
    const two = new Float32Array([...at(10, 5, -3), ...at(-4, 1, 7, 1.2)])
    const hang = clothPivots(box, two, { kind: 'hanging', pin: null })
    expect([...hang.slice(0, 3)]).toEqual([7, 2, 1])
    expect(hang[4]).toBeCloseTo(3, 5)
    expect(hang[5]).toBeCloseTo(2, 5)
    expect(hang[3]).not.toBeCloseTo(hang[7]!, 3)
    const tent = clothPivots(box, two, { kind: 'tent', pin: null })
    expect([tent[0], tent[2], tent[4], tent[6]]).toEqual([5, 3, 1, 3])
    const pinned = clothPivots(box, two, { kind: 'awning', pin: [1.5, 0.8] })
    expect([pinned[0], pinned[1], pinned[2]]).toEqual([6.5, Math.fround(0.8), 2])
    const flat = clothPivots([0, 1, 0, 1, 1, 1], at(0, 0, 0), { kind: 'hanging', pin: null })
    expect(flat[1]).toBeCloseTo(0.05, 6)
    expect([clothKindCode('hanging'), clothKindCode('awning'), clothKindCode('tent'), clothKindCode('flag'), clothKindCode(null)]).toEqual([1, 2, 3, 0, 0])
    expect(clothOf({ cloth: 'tent', clothPin: [1, -2] })).toEqual({ kind: 'tent', pin: null })
    expect(clothOf({ cloth: 'sail' as never })).toBeNull()
    expect(clothOf(undefined)).toBeNull()
  })

  it("joins the converter's manifest carrier (models[].cloth) to the record's cloth (I-11)", () => {
    const side = { name: 'Banner01', flags: 0, diffuse: [1, 1, 1, 1], ambient: [1, 1, 1, 1] }
    expect(withManifestCloth(side, 'Banner01', undefined)).toBe(side)
    expect(withManifestCloth(side, 'Banner01', [{ material: 'other', kind: 'tent' }])).toBe(side)
    expect(withManifestCloth(undefined, 'Banner01', [{ material: 'banner01', kind: 'tent' }])).toBeUndefined()
    const hang = withManifestCloth(side, 'Banner01', [{ material: 'banner01', kind: 'hanging' }])
    expect(clothOf(hang)).toEqual({ kind: 'hanging', pin: null })
    const pinned = withManifestCloth(side, 'Banner01', [{ material: 'BANNER01', kind: 'awning', pinY: 2.5, height: 1.2 }])
    expect(clothOf(pinned)).toEqual({ kind: 'awning', pin: [2.5, 1.2] })
    expect(clothOf(withManifestCloth(side, 'Banner01', [{ material: 'banner01', kind: 'awning', pinY: 2.5 }]))).toEqual({ kind: 'awning', pin: null })
    expect(side).not.toHaveProperty('cloth')
  })
})

// ---- 3. the SRO_CLOTH_WIND slot ------------------------------------------------------------------------------------

/** The part of `code` after `head`, which must be its prefix. */
function suffixAfter(code: string, head: string): string {
  expect(code.startsWith(head)).toBe(true)
  return code.slice(head.length)
}

/** Every line of `code` sits inside `#ifdef SRO_CLOTH_WIND … #endif` blocks (nothing outside them). */
function allUnderClothWind(code: string): boolean {
  const lines = code.split('\n').filter(l => l.length)
  let depth = 0
  for (const l of lines) {
    if (depth === 0 && l !== '#ifdef SRO_CLOTH_WIND') return false
    if (/^#if/.test(l)) depth++
    else if (/^#endif/.test(l)) depth--
  }
  return depth === 0
}

describe('the SRO_CLOTH_WIND slot (D3): HEAD\'s strings without it, the slot only on a cloth plugin', () => {
  it('foliageCode is HEAD\'s (96b1149), byte for byte, in both languages and both stages', () => {
    expect(foliageCode('vertex', 'wgsl')).toEqual(HEAD_FOLIAGE_VERTEX_WGSL_W10R)
    expect(foliageCode('vertex', 'glsl')).toEqual(HEAD_FOLIAGE_VERTEX_GLSL_W10R)
    expect(foliageCode('fragment', 'wgsl')).toEqual(HEAD_FOLIAGE_FRAGMENT_WGSL_W10R)
    expect(foliageCode('fragment', 'glsl')).toEqual(HEAD_FOLIAGE_FRAGMENT_GLSL_W10R)
  })

  it('a tree or converted foliage plugin injects HEAD\'s code; a cloth plugin adds only blocks under SRO_CLOTH_WIND', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const shared = new FoliageShared()
    const tree = new SroFoliagePlugin(new PBRMaterial('tree', scene), shared, { leaf: true, kind: 'static' })
    const cloth = new SroFoliagePlugin(new PBRMaterial('cloth', scene), shared, { leaf: true, kind: 'static', cloth: true })
    expect(cloth.leaf).toBe(false)
    const heads = { vertex: { wgsl: HEAD_FOLIAGE_VERTEX_WGSL_W10R, glsl: HEAD_FOLIAGE_VERTEX_GLSL_W10R }, fragment: { wgsl: HEAD_FOLIAGE_FRAGMENT_WGSL_W10R, glsl: HEAD_FOLIAGE_FRAGMENT_GLSL_W10R } }
    for (const stage of ['vertex', 'fragment'] as const) {
      for (const [lang, sl] of [['wgsl', 1], ['glsl', 0]] as const) {
        const head = heads[stage][lang]
        expect(tree.getCustomCode(stage, sl)).toEqual(head)
        const code = cloth.getCustomCode(stage, sl)!
        expect(Object.keys(code).sort()).toEqual(Object.keys(head).sort())
        expect(code).toEqual(clothFoliageCode(stage, lang))
        for (const [point, text] of Object.entries(code)) {
          const extra = suffixAfter(text, head[point]!)
          if (stage === 'fragment') expect(extra, `${lang} ${point}`).toBe('')
          else {
            expect(extra.length, `${lang} ${point}`).toBeGreaterThan(0)
            expect(allUnderClothWind(extra), `${lang} ${point}`).toBe(true)
          }
        }
      }
    }
    // Each language to itself.
    for (const t of Object.values(clothFoliageCode('vertex', 'glsl'))) expect(t).not.toMatch(/\b(fn|let)\s|vec[234]f\(|vertexInputs|uniforms\./)
    for (const t of Object.values(clothFoliageCode('vertex', 'wgsl'))) expect(t).not.toMatch(/\battribute vec4\b|\bvec4 clothPivot/)
  })

  it('SRO_CLOTH_WIND turns on for a cloth plugin on a mesh with the 4-float pivot only (no tree define with it)', async () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    scene.createDefaultCamera()
    const defs = async (size: 0 | 3 | 4, clothOn: boolean) => {
      const mesh = MeshBuilder.CreateGround(`g${size}${clothOn}`, { width: 1, height: 1 }, scene)
      if (size) mesh.setVerticesData(FOLIAGE_PIVOT_KIND, new Float32Array(mesh.getTotalVertices() * size), false, size)
      const mat = new PBRMaterial(`m${size}${clothOn}`, scene)
      new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'cloth', baked: true })
      const fol = new FoliageShared()
      Object.assign(fol, { active: true, wind: true, translucency: true, u: { wxA: new Vector4(0, 0, 0, 1), wxB: new Vector4(1, 0, 0.5, 1) } })
      new SroFoliagePlugin(mat, fol, { leaf: false, kind: 'static', cloth: clothOn, breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
      mesh.material = mat
      let ready = false
      for (let i = 0; i < 400 && !ready; i++) {
        ready = mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)
        if (!ready) await new Promise(r => setTimeout(r, 5))
      }
      expect(ready).toBe(true)
      const d = mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>
      const effect = mesh.subMeshes[0]!.effect!
      return { d, vertex: (effect as unknown as { _vertexSourceCode: string })._vertexSourceCode, attributes: effect.getAttributesNames() }
    }
    const on = await defs(4, true)
    expect([on.d.SRO_CLOTH_WIND, on.d.SRO_FOL_WIND, on.d.SRO_FOL_FLUTTER, on.d.SRO_FOL_PIVOT, on.d.SRO_FOL_TRANSL, on.d.SRO_FOL_BREEZE]).toEqual([true, false, false, false, false, true])
    expect(on.vertex).toMatch(/clothPivot/)
    expect(on.attributes).toContain(FOLIAGE_PIVOT_KIND)
    for (const [size, c] of [[0, true], [3, true], [4, false]] as const) {
      const off = await defs(size, c)
      expect(off.d.SRO_CLOTH_WIND, `pivot ${size} cloth ${c}`).toBe(false)
      // A cloth plugin without the cloth pivot declares no attribute; only a cloth plugin's source carries the slot.
      if (c) expect(off.attributes, `pivot ${size}`).not.toContain(FOLIAGE_PIVOT_KIND)
      else expect(off.vertex).not.toMatch(/clothPivot/)
    }
  })
})

// ---- 4. life: the float landing ---------------------------------------------------------------------------------

describe('life: the float landing (TOWN_LIFE §4): bob only, no peck-hops', () => {
  const land = (opts: ConstructorParameters<typeof Flock>[2]) => {
    const f = new Flock(6, 42, opts)
    f.spawnGround(10, 2, -4, null, true)
    return f
  }

  it('a floating flock bobs within ±FLOAT_BOB_M of the water and never hops; the default flock is unchanged', () => {
    const float = land({ hops: true, float: true })
    expect(float.options.hops).toBe(false)
    expect(float.options.float).toBe(true)
    const ys: number[] = []
    for (let k = 0; k < 300; k++) {
      float.update(1 / 30, [], null)
      for (let i = 0; i < 6; i++) ys.push(float.pos[i * 3 + 1]!)
    }
    const base = 2 + 0.02
    expect(Math.max(...ys) - base).toBeLessThanOrEqual(FLOAT_BOB_M + 1e-5)
    expect(base - Math.min(...ys)).toBeLessThanOrEqual(FLOAT_BOB_M + 1e-5)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(FLOAT_BOB_M)
    // Without the flag (explicitly false or absent), the same seed moves exactly as before.
    const a = land({ hops: true }), b = land({ hops: true, float: false })
    for (let k = 0; k < 300; k++) {
      a.update(1 / 30, [], null)
      b.update(1 / 30, [], null)
    }
    expect([...a.pos]).toEqual([...b.pos])
    expect(a.options.float).toBe(false)
  })

  it('a habitat with `float` makes a floating habitat flock', () => {
    const birds = new LifeBirds(null as never, 7) as unknown as { directHabitats(ctx: unknown, allowed: boolean): void; flocks: Array<{ flock: Flock }> }
    const species = birdSpeciesOf({ id: 'duck', kind: 'bird', habitat: 'pondSurface', max: 5 }, ['meadow', 'roof', 'fields', 'water'])
    const ctx = {
      focus: { x: 0, y: 0, z: 0 }, threats: [], species: [species],
      ground: { surfaceAt: () => 0 },
      habitat: () => ({ id: 'pondSurface', float: true, weight: () => 1, landing: () => 0.4 }),
    }
    birds.directHabitats(ctx, true)
    expect(birds.flocks).toHaveLength(1)
    expect(birds.flocks[0]!.flock.options.float).toBe(true)
    expect(birds.flocks[0]!.flock.options.hops).toBe(false)
  })
})

// ---- 5. post and water -------------------------------------------------------------------------------------------

const GPU: GpuInfo = { maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 16, features: [], vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false }

function postScene(preset: RenderPreset) {
  const engine = new NullEngine()
  const e = engine as unknown as Record<string, unknown>
  e['createRawTexture3D'] = (_d: unknown, w: number, h: number, d: number, format: number) => {
    const t = new InternalTexture(engine, InternalTextureSource.Raw3D)
    t.baseWidth = t.width = w
    t.baseHeight = t.height = h
    t.baseDepth = t.depth = d
    t.format = format
    t.is3D = true
    t.isReady = true
    return t
  }
  e['updateRawTexture3D'] = () => {}
  engine.getCaps().textureHalfFloatRender = true
  const scene = new Scene(engine)
  const camera = new ArcRotateCamera('cam', 0, 1, 14, Vector3.Zero(), scene)
  scene.activeCamera = camera
  const render = new WorldRender(scene, { mode: 'pbr', quality: RENDER_PRESETS[preset], gpu: GPU })
  cleanups.push(() => {
    render.dispose()
    scene.dispose()
    engine.dispose()
  })
  const post = installRenderPost(render)
  render.attachCamera(camera)
  return { scene, render, post }
}

describe('the post\'s temporal fallback (D4): RenderPost.setTemporalOverride', () => {
  it("'none' from an owner that asked nothing is a no-op (no rebuild, the same plan and stages)", () => {
    for (const p of ['medium', 'high'] as const) {
      const { post, scene } = postScene(p)
      expect(renderPostOf(scene)).toBe(post)
      const plan = JSON.stringify(post.plan)
      const stages = [...post.stages]
      const rebuild = vi.spyOn(post, 'rebuild')
      post.setTemporalOverride('x', 'none')
      expect(rebuild).not.toHaveBeenCalled()
      expect(JSON.stringify(post.plan)).toBe(plan)
      expect(post.stages).toEqual(stages)
      expect(post.temporalOverride).toBe('none')
    }
  })

  it("'msaa4' swaps a TAA preset's TAA for MSAA ×4 while any owner asks; the last 'none' brings TAA back", () => {
    const { post } = postScene('high')
    // (NullEngine cannot build TAA, so the built stages fall back to FXAA; the plan is what the device would build.)
    expect(post.plan.aa).toBe('taa')
    expect(post.plan.stages).toContain('taa')
    const rebuild = vi.spyOn(post, 'rebuild')
    post.setTemporalOverride('town', 'msaa4')
    expect([post.plan.aa, post.plan.msaa, post.plan.sharpen, post.plan.stages.includes('taa'), post.temporalOverride]).toEqual(['msaa', 4, false, false, 'msaa4'])
    expect(post.plan.dropped).toContain('taa → msaa x4: temporal override')
    post.setTemporalOverride('town', 'msaa4')
    post.setTemporalOverride('lab', 'msaa4')
    post.setTemporalOverride('town', 'none')
    expect(post.plan.aa).toBe('msaa')
    expect(rebuild).toHaveBeenCalledTimes(1)
    post.setTemporalOverride('lab', 'none')
    expect([post.plan.aa, post.plan.msaa, post.plan.stages.includes('taa')]).toEqual(['taa', 1, true])
    expect(rebuild).toHaveBeenCalledTimes(2)
  })

  it('a preset without TAA is unchanged (no rebuild); planPost without the option is today\'s', () => {
    const { post } = postScene('medium')
    const plan = JSON.stringify(post.plan)
    const rebuild = vi.spyOn(post, 'rebuild')
    post.setTemporalOverride('town', 'msaa4')
    expect(rebuild).not.toHaveBeenCalled()
    expect(JSON.stringify(post.plan)).toBe(plan)
    expect(post.temporalOverride).toBe('msaa4')
    for (const p of ['low', 'medium', 'high', 'ultra'] as const) {
      for (const mode of ['classic', 'pbr'] as const) {
        expect(planPost(mode, RENDER_PRESETS[p], GPU, { temporal: null }), `${mode} ${p}`).toEqual(planPost(mode, RENDER_PRESETS[p], GPU))
      }
    }
  })
})

/** One region with a 2 × 1 block pond (water-pbr.test.ts' fixture). */
function pondRegion(id = 5): RegionData {
  const heights = new Float32Array(GRID * GRID).fill(-2)
  const region = {
    id, x: id, z: 0, origin: [0, 0, 0],
    blocks: [{ bx: 0, bz: 0, water: { kind: 'water', type: 0, wave: 3, heightM: 0 } }],
  }
  return { region, terrain: { heights }, navmesh: null } as unknown as RegionData
}

async function pbrWater(path: RenderPath = 'pbr') {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const regions = { manifest: { water: { frames: [], frameMs: 100, ice: null } }, regions: [] } as unknown as WorldRegionsT
  const water = new WaterRenderer(scene, regions)
  cleanups.push(() => {
    water.dispose()
    scene.dispose()
    engine.dispose()
  })
  const assets = new Assets('http://mem.test/', { bytes: async () => { throw new Error('no assets') }, decodeImage: async () => ({ width: 1, height: 1, data: new Uint8Array(4) }) })
  const render = { mode: path, quality: RENDER_PRESETS[path === 'pbr' ? 'medium' : 'low'], weather: CLEAR_RENDER_WEATHER }
  water.follow({ render, weather: { rippleTexture: null, u: { wxA: { w: 0 } } } } satisfies WaterRenderSource)
  await water.init(assets)
  return { scene, water }
}

/** The code with every `#ifdef SRO_WATER_RIPPLE … #endif` block removed (nested #if blocks inside are skipped too). */
function withoutRipple(code: Readonly<Record<string, string>>): Record<string, string> {
  const strip = (src: string) => {
    const out: string[] = []
    let depth = 0
    for (const line of src.split('\n')) {
      if (depth > 0) {
        if (/^#if/.test(line)) depth++
        else if (/^#endif\b/.test(line)) depth--
        continue
      }
      if (/^#ifdef SRO_WATER_RIPPLE\s*$/.test(line)) {
        depth = 1
        continue
      }
      out.push(line)
    }
    return out.join('\n')
  }
  // a point that held only rain code (RAIN-P's glint) is gone with it
  return Object.fromEntries(Object.entries(code).map(([k, v]) => [k, strip(v)]).filter(([, v]) => !/^#ifdef SRO_WATER\n#endif\n?$/.test(v!)))
}

/** The material's own plugins (Babylon's PBR built-ins left out). */
const pluginNames = (m: PBRMaterial | null) =>
  ((m?.pluginManager as unknown as { _plugins?: Array<{ name: string }> } | null)?._plugins ?? []).map(p => p.name).filter(n => n.startsWith('Sro'))

describe('the water seams (D5): ripple points and the per-region profile', () => {
  it('with no point and no profile the water is today\'s: one plugin, HEAD\'s strings, b = 0', async () => {
    // RAIN-P (wave 12) rewrote the rain rings, all inside SRO_WATER_RIPPLE: everything else is still the wave-10r water.
    expect(withoutRipple(waterFragmentCode('wgsl'))).toEqual(withoutRipple(HEAD_WATER_FRAGMENT_WGSL_W10R))
    expect(withoutRipple(waterFragmentCode('glsl'))).toEqual(withoutRipple(HEAD_WATER_FRAGMENT_GLSL_W10R))
    const { water } = await pbrWater()
    water.setRipplePoints([])
    water.setRipplePoints(null)
    water.setProfile('town', null)
    water.setProfileLookup(null)
    const [mesh] = water.addRegion(pondRegion()) as [Mesh]
    expect(pluginNames(water.pbrMaterial)).toEqual([SRO_WATER_PLUGIN])
    expect(waterTownPluginOf(water.pbrMaterial)).toBeNull()
    const col = mesh.getVerticesData('color')!
    for (let i = 2; i < col.length; i += 4) expect(col[i]).toBe(0)
  })

  it('ripple points add the town plugin (SRO_WATER_POINTS; at most RIPPLE_POINTS_MAX); the Classic water never shows them', async () => {
    const { water } = await pbrWater()
    water.addRegion(pondRegion())
    const pts = Array.from({ length: RIPPLE_POINTS_MAX + 3 }, (_, i) => ({ x: i, z: -i, radiusM: 1.5, strength: 0.8 }))
    water.setRipplePoints(pts)
    const plugin = waterTownPluginOf(water.pbrMaterial)!
    expect(pluginNames(water.pbrMaterial)).toEqual([SRO_WATER_PLUGIN, SRO_WATER_TOWN_PLUGIN])
    expect(water.townState.pointCount).toBe(RIPPLE_POINTS_MAX)
    expect(water.townState.points[3]!.asArray()).toEqual([3, -3, 1.5, 0.8])
    const d: Record<string, unknown> = {}
    plugin.prepareDefines(d as never)
    expect(d).toEqual({ SRO_WATER_POINTS: true, SRO_WATER_PROFILE: false })
    water.setRipplePoints([])
    plugin.prepareDefines(d as never)
    expect(d.SRO_WATER_POINTS).toBe(false)

    const classic = await pbrWater('classic')
    classic.water.setRipplePoints(pts)
    classic.water.addRegion(pondRegion())
    expect(classic.water.pbrMaterial).toBeNull()
  })

  it("the 'town' profile colours the regions the lookup names (b = 1), now and as they build, and adds SRO_WATER_PROFILE", async () => {
    const { water } = await pbrWater()
    const [a] = water.addRegion(pondRegion(5)) as [Mesh]
    water.setProfile('town', { color: [0.2, 0.25, 0.12], turbidity: 0.7, reflection: 0.5 })
    water.setProfileLookup(id => (id === 5 ? 'town' : null))
    const [b] = water.addRegion(pondRegion(6)) as [Mesh]
    const bOf = (m: Mesh) => new Set(Array.from(m.getVerticesData('color')!).filter((_, i) => i % 4 === 2))
    expect(bOf(water.meshes.find(m => m.name === a.name)!)).toEqual(new Set([1]))
    expect(bOf(b)).toEqual(new Set([0]))
    expect(water.profileOf(5)).toBe('town')
    const d: Record<string, unknown> = {}
    waterTownPluginOf(water.pbrMaterial)!.prepareDefines(d as never)
    expect(d).toEqual({ SRO_WATER_POINTS: false, SRO_WATER_PROFILE: true })
    expect(water.townState.t.asArray().map(v => +v.toFixed(4))).toEqual([0.2, 0.25, 0.12, 0.7])
    expect(water.townState.u.x).toBeCloseTo(0.2, 6)
  })

  it('the town plugin\'s code: both languages, the same points, every line under its defines; the ring\'s TS mirror', () => {
    const w = waterTownFragmentCode('wgsl'), g = waterTownFragmentCode('glsl')
    expect(Object.keys(w).sort()).toEqual(Object.keys(g).sort())
    for (const [point, code] of Object.entries(g)) expect(code, point).not.toMatch(/\b(fn|let)\s|vec[234]f\(|var<private>|fragmentInputs|uniforms\./)
    for (const [point, code] of Object.entries(w)) expect(code, point).not.toMatch(/\b(float|vec[234])\s|texture2D|\btextureSample\(/)
    for (const lang of [w, g]) {
      for (const [point, code] of Object.entries(lang)) {
        expect((code.match(/^#if/gm) ?? []).length, point).toBe((code.match(/^#endif/gm) ?? []).length)
        expect(code.startsWith('#ifdef SRO_WATER\n'), point).toBe(true)
      }
    }
    // The ring: nothing outside the radius or at the centre's crest-free inside, strongest on the crest's flanks.
    expect(rippleTilt(3, 0.4, { radiusM: 2, strength: 1 })).toBe(0)
    const tilts = Array.from({ length: 40 }, (_, i) => Math.abs(rippleTilt(i * 0.05, 0.4, { radiusM: 2, strength: 1 })))
    expect(Math.max(...tilts)).toBeGreaterThan(0.01)
    expect(rippleTilt(1, 0.4, { radiusM: 2, strength: 0 })).toBe(0)
  })
})

// ---- every plugin's UBO member and sampler once (the live-switch rule) -------------------------------------------

function declared(mat: PBRMaterial, lang: ShaderLanguage): { members: string[]; samplers: string[] } {
  const m = mat as unknown as { _shaderLanguage: ShaderLanguage; buildUniformLayout(): void }
  const was = m._shaderLanguage
  m._shaderLanguage = lang
  try {
    m.buildUniformLayout()
  } finally {
    m._shaderLanguage = was
  }
  const pm = mat.pluginManager as unknown as { _uboDeclaration: string; _samplerList: string[] }
  const members = pm._uboDeclaration.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => /^uniform\s+(\w+)\s*:/.exec(l)?.[1] ?? /^\w+\s+(\w+)/.exec(l)?.[1] ?? l)
  return { members, samplers: [...pm._samplerList] }
}

const dupes = (xs: readonly string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))]

describe('no two plugins on one material declare the same uniform or sampler', () => {
  it('the cloth group (surface + foliage cloth slot + fog) and the water with the town plugin, in GLSL and WGSL', async () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const tex = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
    const cloth = new PBRMaterial('batch:opaque+sheen', scene)
    new SroSurfacePlugin(cloth, new SurfaceShared(), { cls: 'cloth', baked: true, table: { albedo: tex, nrao: tex, lightmap: tex, table: tex } })
    new SroFoliagePlugin(cloth, new FoliageShared(), { leaf: false, kind: 'static', cloth: true, breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
    attachFogPlugin(cloth, new HeightFog(scene))
    const { water } = await pbrWater()
    water.addRegion(pondRegion())
    water.setRipplePoints([{ x: 0, z: 0, radiusM: 1, strength: 1 }])
    water.setProfile('town', { color: [0.2, 0.2, 0.1], turbidity: 0.5 })
    attachFogPlugin(water.pbrMaterial!, new HeightFog(water.scene))
    for (const mat of [cloth, water.pbrMaterial!]) {
      for (const lang of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
        const d = declared(mat, lang)
        expect(d.members.length, mat.name).toBeGreaterThan(0)
        expect(dupes(d.members), `${mat.name} ${lang}`).toEqual([])
        expect(dupes(d.samplers), `${mat.name} ${lang}`).toEqual([])
      }
    }
  })
})

// ---- I-11 (WAVE_PLAN7 §6.4): the batcher, the dressing and the cloth with the town part on ------------------------

describe('both items on one world: the batcher, the dressing and a swaying flag (WAVE_PLAN7 §6.4)', () => {
  const ROOT = join(import.meta.dirname, '../../..')
  const JANGAN = JSON.parse(readFileSync(join(ROOT, 'content/town/jangan.json'), 'utf8')) as TownFile
  const MANIFEST = join(ROOT, 'work/out/world/jangan-fields/manifest.json')
  const prims = (m: WorldModel): Prim[] => (m.index === 2 ? [{ ...CLOTH, cloth: 'hanging' }, STALL] : [WALL])

  it("with the town drawing, the batch holds no town mesh and a flag sways with the region's draw count unchanged", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const off = await clothWorld(prims)
    const town = townPartWith({ plan: (w, noFolk) => schedulePlan(JANGAN, w, noFolk), assets: (sc, d) => stubCrowdAssets(sc, d) })
    const on = await clothWorld(prims, town)
    const life = on.world.town as TownLife
    expect(life).toBeInstanceOf(TownLife)
    const cam = new ArcRotateCamera('cam', -Math.PI / 2, 1.2, 12, new Vector3(99, 0, -82), on.scene)
    life.setClock(() => 1_790_014_400)
    for (let k = 0; k < 10; k++) on.world.update(cam)
    const drawnTown = townMeshes(on.scene)
    expect(drawnTown.length).toBeGreaterThan(0)
    expect(life.folk!.frame.drawn).toBeGreaterThan(0)
    // the batcher refuses every town mesh (its tag), and none of its group meshes is one
    for (const m of drawnTown) expect(isBatchableMesh(m), m.name).toBe(false)
    const groups = on.part.meshes()
    for (const m of groups) expect(isTownMesh(m), m.name).toBe(false)
    // the region's batch draws are the town-off world's: the same groups, the same geometry; the flag still sways
    expect(groups.length).toBe(off.part.meshes().length)
    expect(geometryShape(groups)).toEqual(geometryShape(off.part.meshes()))
    expect(on.part.stats.clothGroups).toBe(on.regions)
    for (const m of sheenOf(on)) {
      expect(m.getVertexBuffer(FOLIAGE_PIVOT_KIND)!.getSize()).toBe(CLOTH_PIVOT_SIZE)
      expect(foliagePluginOf(m.material!)!.cloth).toBe(true)
    }
  }, 60_000)

  it.skipIf(!existsSync(MANIFEST))('on the export, the dressing placements are static placements of batchable models in their regions', () => {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      regions: Array<{ id: number }>
      models: Array<{ index: number; source: string; kind: string; cloth?: Array<{ material: string; kind: string }> }>
      placements: Array<{ uid: number; region: number; models: number[]; source: string }>
    }
    const regions = new Set(m.regions.map(r => r.id))
    const dressing = m.placements.filter(p => p.uid >= 1_000_000)
    expect(dressing.length).toBeGreaterThan(100)
    for (const p of dressing) {
      expect(regions.has(p.region), `${p.source} uid ${p.uid}`).toBe(true)
      for (const i of p.models) expect(m.models[i]!.kind, `${p.source}: ${m.models[i]!.source}`).toBe('static')
    }
    // the dressing's banner is a cloth model (it sways in its region's +sheen group, not as a town mesh)
    const banner = m.models.find(x => x.source === 'town/props/banner')
    expect(banner?.cloth?.[0]?.kind).toBe('hanging')
    expect(dressing.some(p => p.models.includes(banner!.index))).toBe(true)
  })
})
