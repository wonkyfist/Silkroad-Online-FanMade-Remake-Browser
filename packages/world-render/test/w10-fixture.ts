/**
 * Wave-10 seam fixtures (docs/WAVE_PLAN6.md §4.1, W10-S): a streamed World over the synthetic 7 × 7 fixture on either
 * material path, with fake parts (a region batcher that merges nothing but records the contract, a ground-cover field,
 * a wildlife part, an ocean) so the seams are tested before BT-M, GL-F, GL-L and CST-O exist.
 */
import {
  AssetContainer,
  Color3,
  MeshBuilder,
  NullEngine,
  Observable,
  PBRMaterial,
  Scene,
  Vector3,
  type AbstractMesh,
  type BaseTexture,
  type Camera,
  type Mesh,
} from '@babylonjs/core'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  RegionStreamer,
  STREAM_DEFAULTS,
  World,
  WorldRegions,
  loadNavStreamed,
  prepareStatic,
  type BatchCommitContext,
  type BatchModelSource,
  type BatchPart,
  type BatchRegion,
  type BatchSlot,
  type CachedModel,
  type CoastAccess,
  type GroundCover,
  type LifePart,
  type LoadWorldOptions,
  type OceanPart,
  type RegionBatch,
  type RegionData,
  type RenderPath,
  type ScatterLevel,
} from '../src/index.ts'
import { BASE_URL, CX, CZ, makeFixture, settle, type Fixture } from './stream-fixture.ts'

/** The retail tuft model the fixtures add (GRASS_LIFE §1.3: group_grs01). */
export const TUFT_SOURCE = 'res\\nature\\common\\grass\\group_grs01.bsr'
/** A lamp model (night-lights LAMP_MODEL). */
export const LAMP_SOURCE = 'res\\bldg\\china\\jangan\\cj_stone_lamp01.bsr'

export const centre = (x: number, z: number) => ({ x: 192 * (x - CX) + 96, z: -192 * (z - CZ) - 96 })

/** Adds a static model with one placement per region (in the region's south-west quarter). Returns its index. */
export function addModel(fx: Fixture, source: string, opts: { kind?: 'static' | 'skinned'; regions?: (id: number) => boolean } = {}): number {
  const m = fx.manifest
  const index = m.models.length
  m.models.push({
    index, source, glb: `models/m${index}.glb`, sidecar: null, kind: opts.kind ?? 'static', animations: [], defaultClip: null,
    lightmappedMeshes: 0, boundsMin: [-1, 0, -1], boundsMax: [1, 2, 1], bytes: 0, validatorErrors: null,
  } as WorldModel)
  for (const r of m.regions) {
    if (opts.regions && !opts.regions(r.id)) continue
    const [x0, y0, z0] = r.origin
    m.placements.push({
      objId: index, source, models: [index], compound: false, position: [x0 + 40, y0 + r.bounds.min[1], z0 - 40], rotation: [0, 0, 0, 1],
      yaw: 0, flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid: m.placements.length, region: r.id, group: 2,
      inConvertedRegion: true,
    } as WorldPlacement)
  }
  return index
}

/** Fake model loads: a box container (with a PBR material; `tag` puts a world tag on its mesh), counted. */
export function fakeModels(scene: Scene, tag: (model: WorldModel) => string | null = () => null) {
  const loads: number[] = []
  const disposed: number[] = []
  const loadModel = async (model: WorldModel): Promise<CachedModel> => {
    loads.push(model.index)
    const container = new AssetContainer(scene)
    const box = MeshBuilder.CreateBox(`box${model.index}`, { size: 1 }, scene) as Mesh
    scene.removeMesh(box)
    const mat = new PBRMaterial(`mat${model.index}`, scene)
    scene.removeMaterial(mat)
    box.material = mat
    const t = tag(model)
    if (t) box.metadata = { sroWorld: t }
    container.meshes.push(box)
    container.materials.push(mat)
    return { model, container, converted: null, prep: model.kind === 'static' ? prepareStatic(container) : null }
  }
  const disposeModel = (e: CachedModel) => {
    disposed.push(e.model.index)
    e.container.dispose()
  }
  return { loads, disposed, loadModel, disposeModel }
}

// ---- a fake region batcher (BT-M's stand-in) ------------------------------------------------------------------------

export interface FakeBatchOptions {
  /** Which models it takes (default: every one offered). */
  accept?: (model: WorldModel) => boolean
  /** Hold every build until `finish(owner)` / `finishAll()`. */
  hold?: boolean
  /** Its material slots per claimed model (default: one plain slot per model). */
  slots?: (model: WorldModel, scene: Scene) => Array<Omit<BatchSlot, 'slot'>>
  /** The model to load in another's place (BT-T's static variants). */
  modelFor?: (model: WorldModel) => WorldModel
}

/** A region batcher that "merges" a region into one box and records every call of the contract. */
export class FakeBatch implements BatchPart {
  readonly claims: Array<{ owner: number; model: number; placements: number; entry: boolean }> = []
  readonly offered: number[] = []
  readonly commits: number[] = []
  readonly removed: number[] = []
  readonly scales: number[] = []
  readonly visible: boolean[] = []
  readonly emissive = new Map<number, [number, number, number]>()
  readonly live = new Map<number, RegionBatch>()
  released = 0
  disposed = 0
  updates = 0
  private readonly owned = new Map<number, BatchModelSource[]>()
  private readonly waiting = new Map<number, () => void>()
  private nextSlot = 0
  stats = { regions: 0 }

  constructor(readonly scene: Scene, readonly opts: FakeBatchOptions = {}) {
    if (opts.modelFor) this.modelFor = opts.modelFor
  }

  modelFor?: (model: WorldModel) => WorldModel

  claim(owner: number, source: BatchModelSource, placements: readonly WorldPlacement[]): readonly WorldPlacement[] {
    this.offered.push(source.model.index)
    if (this.opts.accept && !this.opts.accept(source.model)) return []
    this.claims.push({ owner, model: source.model.index, placements: placements.length, entry: !!source.entry })
    const list = this.owned.get(owner) ?? []
    list.push(source)
    this.owned.set(owner, list)
    return placements
  }

  commit(region: BatchRegion, ctx: BatchCommitContext): Promise<RegionBatch | null> | RegionBatch | null {
    this.commits.push(region.owner)
    const make = (): RegionBatch | null => {
      if (!ctx.alive() || !this.owned.has(region.owner)) return null
      const mesh = MeshBuilder.CreateBox(`batch:${region.owner}`, { size: 2 }, this.scene)
      mesh.position.set(region.origin[0] + 96, region.origin[1] + 1, region.origin[2] - 96)
      mesh.metadata = { sroWorld: 'object', sroBatch: 'test' }
      const proxy = MeshBuilder.CreateBox(`batchProxy:${region.owner}`, { size: 2 }, this.scene)
      proxy.position.copyFrom(mesh.position)
      const slots: BatchSlot[] = []
      for (const src of this.owned.get(region.owner) ?? []) {
        const defs = this.opts.slots?.(src.model, this.scene) ?? [{ model: src.model, material: plainMaterial(this.scene), record: null, cls: 'merge' as const }]
        for (const d of defs) slots.push({ ...d, slot: this.nextSlot++ })
      }
      const batch: RegionBatch = {
        owner: region.owner, region: region.id, meshes: [mesh], shadowProxy: proxy, cutoutCasters: [], slots,
        min: new Vector3(region.origin[0], region.origin[1], region.origin[2] - 192),
        max: new Vector3(region.origin[0] + 192, region.origin[1] + 10, region.origin[2]),
        setEmissive: (slot, r, g, b) => {
          if (this.live.get(region.owner) === batch) this.emissive.set(slot, [r, g, b])
        },
      }
      this.live.set(region.owner, batch)
      this.stats.regions = this.live.size
      return batch
    }
    if (!this.opts.hold) return make()
    return new Promise(resolve => this.waiting.set(region.owner, () => resolve(make())))
  }

  finish(owner: number): void {
    const run = this.waiting.get(owner)
    this.waiting.delete(owner)
    run?.()
  }

  finishAll(): void {
    for (const owner of [...this.waiting.keys()]) this.finish(owner)
  }

  get holding(): number {
    return this.waiting.size
  }

  removeRegion(owner: number): void {
    this.removed.push(owner)
    this.owned.delete(owner)
    const b = this.live.get(owner)
    if (b) {
      for (const m of b.meshes) m.dispose()
      b.shadowProxy?.dispose()
      this.live.delete(owner)
    }
    this.stats.regions = this.live.size
  }

  setRangeScale(scale: number): void {
    this.scales.push(scale)
  }

  setVisible(on: boolean): void {
    this.visible.push(on)
  }

  update(): void {
    this.updates++
  }

  meshes(): AbstractMesh[] {
    return [...this.live.values()].flatMap(b => [...b.meshes])
  }

  release(): void {
    this.released++
    for (const owner of [...this.live.keys()]) this.removeRegion(owner)
    this.owned.clear()
    this.waiting.clear()
  }

  dispose(): void {
    this.disposed++
  }
}

function plainMaterial(scene: Scene): PBRMaterial {
  const m = new PBRMaterial('slot', scene)
  m.emissiveColor = new Color3(0, 0, 0)
  return m
}

// ---- fake field, wildlife and ocean ---------------------------------------------------------------------------------

/** A ground cover that records its calls (GL-F's stand-in). */
export class FakeField implements GroundCover {
  readonly style = 'field' as const
  readonly regions = new Set<number>()
  readonly levels: ScatterLevel[] = []
  updates = 0
  disposed = false
  addRegion(data: RegionData): void {
    this.regions.add(data.region.id)
  }

  removeRegion(id: number): boolean {
    return this.regions.delete(id)
  }

  update(): void {
    this.updates++
  }

  setLevel(level: ScatterLevel): void {
    this.levels.push(level)
  }

  ready(): Promise<void> {
    return Promise.resolve()
  }

  meshes(): Mesh[] {
    return []
  }

  dispose(): void {
    this.disposed = true
  }
}

/** A wildlife part that records its calls (GL-L's stand-in); `order` is shared with the other fakes. */
export class FakeLife implements LifePart {
  enabled = true
  readonly configs: Array<{ groundFlocks?: boolean }> = []
  threats: (() => readonly { x: number; y: number; z: number }[]) | null = null
  updates = 0
  disposed = false
  readonly onFlush = new Observable<{ x: number; y: number; z: number; count: number }>()
  constructor(readonly order: string[] = []) {}
  setEnabled(on: boolean): void {
    this.enabled = on
  }

  configure(c: { groundFlocks?: boolean }): void {
    this.configs.push(c)
  }

  setThreats(fn: (() => readonly { x: number; y: number; z: number }[]) | null): void {
    this.threats = fn
  }

  addSpecies(): () => void {
    return () => {}
  }

  addHabitat(): () => void {
    return () => {}
  }

  setFocus(): void {}
  update(_camera: Camera | null, _dt: number): void {
    this.updates++
    this.order.push('life')
  }

  meshes(): AbstractMesh[] {
    return []
  }

  dispose(): void {
    this.disposed = true
  }
}

/** An ocean part with a coast field: sea wherever x > seaX (CST-O's stand-in). */
export class FakeOcean implements OceanPart {
  readonly coast: CoastAccess
  readonly mesh: Mesh
  updates = 0
  disposed = false
  quality: unknown = undefined
  constructor(scene: Scene, readonly seaX: number, seaLevelM = 5, readonly order: string[] = []) {
    this.coast = { seaLevelM, seaAt: (x: number) => x > seaX }
    this.mesh = MeshBuilder.CreateGround('ocean', { width: 10, height: 10 }, scene)
    this.mesh.metadata = { sroWorld: 'ocean' }
  }

  update(): void {
    this.updates++
    this.order.push('ocean')
  }

  meshes(): AbstractMesh[] {
    return [this.mesh]
  }

  setQuality(q: unknown): void {
    this.quality = q
  }

  dispose(): void {
    this.disposed = true
    this.mesh.dispose()
  }
}

// ---- the streamed world -------------------------------------------------------------------------------------------

export interface W10Setup {
  engine: NullEngine
  scene: Scene
  world: World
  stream: RegionStreamer
  fx: Fixture
  models: ReturnType<typeof fakeModels>
  /** Streams around `focus` until idle. */
  run(focus?: { x: number; z: number }, frames?: number): Promise<void>
  dispose(): void
}

export interface W10Options extends Partial<Pick<LoadWorldOptions, 'parts' | 'batching' | 'grassStyle' | 'hideRetailTufts' | 'wildlife' | 'quality'>> {
  render?: RenderPath
  /** Changes the fixture before the world is made (extra models). */
  edit?: (fx: Fixture) => void
  /** Tags a fake model's mesh. */
  tag?: (model: WorldModel) => string | null
}

/** A World on `render` over the fixture, with a streamer on fake models (no timer pump). */
export async function w10World(o: W10Options = {}): Promise<W10Setup> {
  const fx = makeFixture()
  o.edit?.(fx)
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const assets = new Assets(BASE_URL, fx.io)
  const nav = await loadNavStreamed(fx.manifest, assets)
  const world = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, {
    baseUrl: BASE_URL, minimap: false, render: o.render ?? 'pbr', parts: o.parts, batching: o.batching, grassStyle: o.grassStyle,
    hideRetailTufts: o.hideRetailTufts, wildlife: o.wildlife, quality: o.quality,
  })
  await world.water.init(assets)
  const models = fakeModels(scene, o.tag)
  const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium }, {
    now: () => 0,
    autoPump: false,
    objects: true,
    nav: nav.chunks,
    loadModel: models.loadModel,
    disposeModel: models.disposeModel,
    atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true },
  })
  world.stream = stream
  stream.booting = false
  const run = async (focus = centre(CX, CZ), frames = 600) => {
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
  return { engine, scene, world, stream, fx, models, run, dispose }
}

/** Runs frames without waiting for idle (the batch builds may be held). */
export async function pump(s: W10Setup, frames = 200, focus = centre(CX, CZ)): Promise<void> {
  for (let i = 0; i < frames; i++) {
    s.stream.update(focus, null)
    await settle(2)
  }
}
