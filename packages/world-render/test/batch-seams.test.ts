/**
 * W10-S, batching seams (docs/BATCHING.md BT-0, §3.1, F9–F12; docs/WAVE_PLAN6.md §4.1 step 1, D2–D9): batching off
 * is HEAD (chunks, clones, draws); a claimed region places no chunks; its listeners hear `placed` with no meshes and
 * then `batched`; 'objects' waits for the batch; `removeRegion` reaches the batcher; Classic never batches; NL's lamp
 * slots get the kind colour at night; `setRangeScale(0.6)` reaches the batch; PBR → Classic → PBR leaves no batch
 * meshes, slots or cells and restores today's chunks; the shadow listener takes the batch's own proxy; the claim never
 * takes a mesh tagged 'scatter' / 'life' / 'ocean', and the retail-tuft filter runs before the batcher sees a region.
 * Also the geometry export (dequantized, the node transform baked in) and the material batch records.
 */
import {
  AssetContainer,
  Color3,
  DirectionalLight,
  Matrix,
  Mesh,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  Scene,
  TransformNode,
  Vector3,
  VertexBuffer,
  type AbstractMesh,
} from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import {
  NIGHT_LIGHT_KINDS,
  NightLights,
  RENDER_PRESETS,
  ShadowProxies,
  WorldShadows,
  batchClass,
  extractModelGeometry,
  geometryOf,
  isBatchableMesh,
  lampRule,
  prepareStatic,
  type BatchFactory,
  type MaterialBatchRecord,
  type NightLightsHost,
  type PlacedModelInfo,
  type RegionBatch,
  type RegionListener,
} from '../src/index.ts'
import { CX, CZ, X0 } from './stream-fixture.ts'
import { FakeBatch, FakeField, LAMP_SOURCE, TUFT_SOURCE, addModel, centre, pump, w10World, type W10Setup } from './w10-fixture.ts'

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

/** A batch factory that makes FakeBatch parts and remembers them. */
function fakeFactory(opts: ConstructorParameters<typeof FakeBatch>[1] = {}) {
  const made: FakeBatch[] = []
  const factory: BatchFactory = host => {
    const b = new FakeBatch(host.scene, opts)
    made.push(b)
    return b
  }
  return { made, factory: vi.fn(factory) }
}

/** A listener that records every call (meshes by reference). */
function recorder() {
  const placed: Array<{ region: number; model: number; info: PlacedModelInfo; meshes: AbstractMesh[]; placements: number }> = []
  const removed: number[] = []
  const batched: Array<{ region: number; batch: RegionBatch }> = []
  const l: RegionListener = {
    placed: (region, model, info, meshes, placements) => placed.push({ region, model: model.index, info, meshes: [...meshes], placements: placements.length }),
    removed: region => removed.push(region),
    batched: (region, batch) => batched.push({ region, batch }),
  }
  return { l, placed, removed, batched }
}

/**
 * What HEAD's objects look like: their counters, and their meshes by name with the chunk owner (a serial shared by
 * every world in the process) masked, and their thin-instance counts.
 */
function objectsShape(s: W10Setup) {
  const st = s.world.objects.stats
  return {
    chunks: st.chunks, thinInstances: st.thinInstances, instanceMeshes: st.instanceMeshes, clones: st.clones, cloneMeshes: st.cloneMeshes,
    meshes: s.world.objects.meshes().map(m => `${m.name.replace(/\|\d+\|/, '|#|')}×${(m as Mesh).thinInstanceCount ?? 0}`).sort(),
  }
}

describe('batching off is HEAD', () => {
  it('no batcher on the PBR path (BT-M not built, explicit none, or batching off): the same chunks, clones and meshes as Classic', async () => {
    const classic = await world({ render: 'classic' })
    await classic.run()
    const head = objectsShape(classic)
    expect(head.chunks).toBeGreaterThan(0)
    expect(head.clones).toBe(1)

    const stub = await world({ render: 'pbr', parts: { batch: null } })
    await stub.run()
    expect(stub.world.batch).toBeNull()
    expect(stub.world.objects.batcher).toBeNull()
    expect(objectsShape(stub)).toEqual(head)

    const off = fakeFactory()
    const disabled = await world({ render: 'pbr', batching: false, parts: { batch: off.factory } })
    await disabled.run()
    expect(off.factory).not.toHaveBeenCalled()
    expect(disabled.world.batching).toBe(false)
    expect(objectsShape(disabled)).toEqual(head)
  })

  it('a batcher that claims nothing changes nothing, and every region is ready as before', async () => {
    const f = fakeFactory({ accept: () => false })
    const s = await world({ parts: { batch: f.factory } })
    await s.run()
    const b = f.made[0]!
    expect(s.world.batch).toBe(b)
    expect(b.offered.length).toBeGreaterThan(0)
    expect(b.commits).toEqual([])
    expect(s.stream.stats.objectsReady).toBe(s.stream.stats.ready)
    const classic = await world({ render: 'classic' })
    await classic.run()
    expect(objectsShape(s)).toEqual(objectsShape(classic))
  })
})

describe('the claim and the listener contract', () => {
  it('a claimed region places no chunks; placed hears no meshes, then batched brings the batch', async () => {
    const f = fakeFactory()
    const s = await world({ parts: { batch: f.factory } })
    const r = recorder()
    s.world.objects.addRegionListener(r.l)
    await s.run()
    const b = f.made[0]!
    const regions = s.stream.stats.ready
    expect(regions).toBeGreaterThan(1)
    // Model 0 (static, one per region) is claimed everywhere; the centre's skinned clone is never offered.
    expect(s.world.objects.stats.chunks).toBe(0)
    expect(s.world.objects.stats.clones).toBe(1)
    expect(new Set(b.claims.map(c => c.model))).toEqual(new Set([0]))
    expect(b.claims.every(c => c.entry)).toBe(true)
    expect(r.batched).toHaveLength(regions)
    const batchMeshes = new Set(r.batched.flatMap(e => [...e.batch.meshes]))
    for (const p of r.placed) for (const m of p.meshes) expect(batchMeshes.has(m), `${m.name} came through placed`).toBe(false)
    expect(r.placed.filter(p => p.model === 0).every(p => p.meshes.length === 0 && p.placements === 1)).toBe(true)
    // The batch meshes are the world's objects (World.meshes, the shelter candidates); the regions count as placed.
    const all = new Set(s.world.meshes())
    for (const m of batchMeshes) expect(all.has(m)).toBe(true)
    expect(s.world.objects.regionCount()).toBe(regions)
    expect(s.world.objects.regionBatches.size).toBe(regions)
  })

  it('a listener added later hears the placements (no meshes) and the batches again', async () => {
    const f = fakeFactory()
    const s = await world({ parts: { batch: f.factory } })
    await s.run()
    const r = recorder()
    s.world.objects.addRegionListener(r.l)
    expect(r.batched).toHaveLength(s.stream.stats.ready)
    expect(r.placed.filter(p => p.model === 0).every(p => p.meshes.length === 0)).toBe(true)
  })

  it("'objects' (and every 'objects' commit step) waits for the region's batch", async () => {
    const f = fakeFactory({ hold: true })
    const s = await world({ parts: { batch: f.factory } })
    const stepped: number[] = []
    s.world.addCommitStep('probe', data => stepped.push(data.region.id), 'objects')
    await pump(s, 200)
    const b = f.made[0]!
    expect(s.stream.stats.ready).toBeGreaterThan(0)
    expect(b.holding).toBe(s.stream.stats.ready)
    expect(s.stream.stats.objectsReady).toBe(0)
    expect(stepped).toEqual([])
    b.finishAll()
    await s.run()
    expect(s.stream.stats.objectsReady).toBe(s.stream.stats.ready)
    expect(stepped.length).toBe(s.stream.stats.ready)
  })

  it('removeRegion reaches the batcher and the listeners; a batch landing after its region went is dropped', async () => {
    const f = fakeFactory()
    const s = await world({ parts: { batch: f.factory } })
    const r = recorder()
    s.world.objects.addRegionListener(r.l)
    await s.run()
    const b = f.made[0]!
    const before = new Set(b.live.keys())
    // Far west: the east regions unload.
    await s.run({ x: centre(X0, CZ).x - 900, z: centre(X0, CZ).z })
    const gone = [...before].filter(o => !b.live.has(o))
    expect(gone.length).toBeGreaterThan(0)
    for (const o of gone) {
      expect(b.removed).toContain(o)
      expect(r.removed).toContain(o)
      expect(s.world.objects.regionBatches.has(o)).toBe(false)
    }
    expect(s.scene.meshes.filter(m => m.name.startsWith('batch:') && !m.isDisposed()).length).toBe(b.live.size)

    // A held build whose region unloads meanwhile never lands.
    const g = fakeFactory({ hold: true })
    const t = await world({ parts: { batch: g.factory } })
    await pump(t, 200)
    const h = g.made[0]!
    const owners = [...(h as unknown as { waiting: Map<number, () => void> }).waiting.keys()]
    expect(owners.length).toBeGreaterThan(0)
    await pump(t, 50, { x: 50_000, z: 50_000 })
    h.finishAll()
    await pump(t, 5, { x: 50_000, z: 50_000 })
    expect(h.live.size).toBe(0)
    expect(t.world.objects.regionBatches.size).toBe(0)
  })

  it('modelFor: a region loads the batcher\'s stand-in (a static tree variant) and places it for the original model', async () => {
    let variant = -1
    const f = fakeFactory({
      modelFor: m => (m.index === 1 ? { ...m, index: variant, kind: 'static', glb: `models/m${variant}.glb` } : m),
    })
    const s = await world({
      parts: { batch: f.factory },
      edit: fx => {
        // The static variant of the skinned model 1 (BT-C's `models[i].staticVariant`), placed nowhere itself.
        variant = fx.manifest.models.length
        fx.manifest.models.push({ ...fx.manifest.models[1]!, index: variant, kind: 'static', glb: `models/m${variant}.glb`, source: 'tree_static.bsr' })
      },
    })
    const r = recorder()
    s.world.objects.addRegionListener(r.l)
    await s.run()
    expect(s.models.loads).toContain(variant)
    expect(s.models.loads).not.toContain(1)
    expect(s.world.objects.stats.clones).toBe(0)
    // The listeners hear the placed model (1), not the variant; the batcher got the variant's entry.
    expect(r.placed.some(p => p.model === 1 && p.meshes.length === 0 && p.info.kind === 'static')).toBe(true)
    expect(f.made[0]!.claims.some(c => c.model === 1 && c.entry)).toBe(true)
    // With batching off the skinned model loads as today.
    const off = await world({ parts: { batch: null } })
    await off.run()
    expect(off.models.loads).toContain(1)
    expect(off.world.objects.stats.clones).toBe(1)
  })

  it('Classic never batches: no part, no batcher, whatever the flag says', async () => {
    const f = fakeFactory()
    const s = await world({ render: 'classic', parts: { batch: f.factory } })
    await s.run()
    s.world.setBatching(false)
    s.world.setBatching(true)
    expect(f.factory).not.toHaveBeenCalled()
    expect(s.world.batch).toBeNull()
    expect(s.world.objects.batcher).toBeNull()
    expect(s.world.objects.stats.chunks).toBeGreaterThan(0)
  })

  it('setRangeScale (Options sight, the create cap 0.6) and the static toggle reach the batch live', async () => {
    const f = fakeFactory()
    const s = await world({ parts: { batch: f.factory } })
    await s.run()
    const b = f.made[0]!
    expect(b.scales[0]).toBe(1) // the current scale when the batcher was set
    s.world.objects.setRangeScale(0.6)
    expect(b.scales.at(-1)).toBe(0.6)
    s.world.setQuality('high')
    expect(b.scales.at(-1)).toBe(1.4)
    s.world.objects.setStaticVisible(false)
    expect(b.visible.at(-1)).toBe(false)
    s.world.objects.update(new Vector3(1, 2, 3), true)
    expect(b.updates).toBeGreaterThan(0)
  })

  it('PBR → Classic → PBR releases every batch (no meshes, slots or cells left), places today\'s chunks, then claims again', async () => {
    const f = fakeFactory()
    const s = await world({ parts: { batch: f.factory } })
    await s.run()
    const first = f.made[0]!
    expect(first.live.size).toBeGreaterThan(0)
    s.world.setRenderMode('classic')
    expect(first.released).toBe(1)
    expect(first.disposed).toBe(1)
    expect(first.live.size).toBe(0)
    expect(s.world.batch).toBeNull()
    expect(s.world.objects.batcher).toBeNull()
    expect(s.world.objects.regionBatches.size).toBe(0)
    expect(s.scene.meshes.filter(m => m.name.startsWith('batch') && !m.isDisposed())).toEqual([])
    await s.run()
    expect(s.world.objects.stats.chunks).toBeGreaterThan(0)
    const chunks = s.world.objects.stats.chunks

    s.world.setRenderMode('pbr')
    expect(f.factory).toHaveBeenCalledTimes(2)
    const second = f.made[1]!
    expect(s.world.batch).toBe(second)
    await s.run()
    expect(second.live.size).toBe(s.stream.stats.ready)
    expect(s.world.objects.stats.chunks).toBe(0)
    expect(chunks).toBe(s.stream.stats.ready)
  })

  it('World.setBatching releases and rebuilds (W10-G\'s Advanced row)', async () => {
    const f = fakeFactory()
    const s = await world({ parts: { batch: f.factory } })
    await s.run()
    const first = f.made[0]!
    s.world.setBatching(false)
    expect(first.released).toBe(1)
    expect(s.world.batch).toBeNull()
    await s.run()
    expect(s.world.objects.stats.chunks).toBe(s.stream.stats.ready)
    s.world.setBatching(true)
    await s.run()
    expect(f.made).toHaveLength(2)
    expect(s.world.objects.stats.chunks).toBe(0)
  })

  it('dispose releases the part', async () => {
    const f = fakeFactory()
    const s = await world({ parts: { batch: f.factory } })
    await s.run()
    s.dispose()
    expect(f.made[0]!.released).toBe(1)
    expect(f.made[0]!.disposed).toBe(1)
  })
})

describe('the claim never takes ground cover, wildlife or the ocean; the tuft filter comes first (D3, D7)', () => {
  it("a model whose mesh is tagged 'scatter', 'life' or 'ocean' is never offered: it places as chunks", async () => {
    let tagged = -1
    const f = fakeFactory()
    const s = await world({
      parts: { batch: f.factory },
      edit: fx => {
        tagged = addModel(fx, 'res\\test\\tagged.bsr')
      },
      tag: m => (m.index === tagged ? 'scatter' : null),
    })
    await s.run()
    const b = f.made[0]!
    expect(b.offered).not.toContain(tagged)
    expect(s.world.objects.stats.chunks).toBe(s.stream.stats.ready) // the tagged model's chunks only
    for (const tag of ['scatter', 'life', 'ocean']) expect(isBatchableMesh({ metadata: { sroWorld: tag } })).toBe(false)
    expect(isBatchableMesh({ metadata: { sroWorld: 'object' } })).toBe(true)
    expect(isBatchableMesh({})).toBe(true)
  })

  it('with the new grass on the PBR path the tufts are never loaded, offered or told; hideRetailTufts: false keeps them', async () => {
    let tuft = -1
    const edit = (fx: Parameters<typeof addModel>[0]) => {
      tuft = addModel(fx, TUFT_SOURCE)
    }
    const field = () => new FakeField()
    const f = fakeFactory()
    const s = await world({ parts: { batch: f.factory, grass: field }, grassStyle: 'field', edit })
    const r = recorder()
    s.world.objects.addRegionListener(r.l)
    await s.run()
    expect(s.world.scatter.style).toBe('field')
    expect(s.world.retailTuftsHidden).toBe(true)
    expect(s.models.loads).not.toContain(tuft)
    expect(f.made[0]!.offered).not.toContain(tuft)
    expect(r.placed.some(p => p.model === tuft)).toBe(false)

    const g = fakeFactory()
    const keep = await world({ parts: { batch: g.factory, grass: field }, grassStyle: 'field', hideRetailTufts: false, edit })
    await keep.run()
    expect(keep.world.retailTuftsHidden).toBe(false)
    expect(g.made[0]!.offered).toContain(tuft)
  })
})

describe('NL lamp slots (F9: one lamp rule, the kind colour at night through the table)', () => {
  it('a merged lamp slot gets base + kind colour × 0.8 × night; a plain slot nothing; the owner going drops them', async () => {
    let lamp = -1
    const slots = (model: WorldModel, scene: Scene) => {
      const m = new PBRMaterial(model.index === lamp ? 'stone' : 'wall', scene)
      m.emissiveColor = new Color3(0.1, 0, 0)
      return [{ model, material: m, record: null, cls: model.index === lamp ? 'lamp' as const : 'merge' as const }]
    }
    const f = fakeFactory({ slots })
    const s = await world({
      parts: { batch: f.factory },
      edit: fx => {
        lamp = addModel(fx, LAMP_SOURCE, { regions: id => id === ((CZ << 8) | CX) })
      },
    })
    await s.run()
    const b = f.made[0]!
    const w = s.world
    const sky = { night: 1 }
    const host: NightLightsHost = {
      scene: s.scene, assets: w.assets, objects: w.objects, terrain: w.terrain, scatter: w.scatter, render: w.render, skyState: sky,
      addCommitStep: (name, run, after, debounce) => w.addCommitStep(name, run, after, debounce),
    }
    const nl = new NightLights(host, { index: new Map(), autoUpdate: false, focus: () => null })
    cleanups.unshift(() => nl.dispose())
    await nl.ready
    nl.update()
    const lampSlot = [...b.live.values()].flatMap(x => [...x.slots]).find(x => x.model.index === lamp)!
    const plain = [...b.live.values()].flatMap(x => [...x.slots]).filter(x => x.model.index !== lamp)
    expect(lampSlot).toBeDefined()
    const k = NIGHT_LIGHT_KINDS[0]!.color
    const got = b.emissive.get(lampSlot.slot)!
    expect(got[0]).toBeCloseTo(0.1 + k[0] * 0.8, 5)
    expect(got[1]).toBeCloseTo(k[1] * 0.8, 5)
    expect(got[2]).toBeCloseTo(k[2] * 0.8, 5)
    for (const p of plain) expect(b.emissive.has(p.slot)).toBe(false)
    expect(nl.stats.lampSlots).toBe(1)
    // By day the glow goes back to the base.
    sky.night = 0
    nl.update()
    expect(b.emissive.get(lampSlot.slot)).toEqual([0.1, 0, 0])
    // The region unloading drops the slot.
    await s.run({ x: 50_000, z: 50_000 })
    expect(nl.stats.lampSlots).toBe(0)
  })

  it('lampRule is NL\'s rule; batchClass keeps Classic, unlit and blended materials separate and lamps in the lamp group', () => {
    expect(lampRule(LAMP_SOURCE, 'stone', false)).toBe(true)
    expect(lampRule('res\\bldg\\house.bsr', 'window_light', false)).toBe(false)
    expect(lampRule('res\\bldg\\house.bsr', 'window_light', true)).toBe(true)
    expect(lampRule('res\\bldg\\house.bsr', 'roof', true)).toBe(false)
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => engine.dispose())
    const rec = (over: Partial<MaterialBatchRecord>): MaterialBatchRecord => ({
      material: new PBRMaterial('m', scene), path: 'pbr', model: { model: 'm.glb', source: 'res\\x\\wall.bsr', kind: 'static' }, name: 'wall',
      texture: null, cls: 'stone', unlit: false, alpha: 'opaque', twoSided: false, lightmap: null, lampModel: false, emissive: false, maps: null,
      ...over,
    })
    expect(batchClass(rec({}))).toBe('merge')
    expect(batchClass(rec({ alpha: 'mask' }))).toBe('merge')
    expect(batchClass(rec({ path: 'classic' }))).toBe('separate')
    expect(batchClass(rec({ unlit: true }))).toBe('separate')
    expect(batchClass(rec({ alpha: 'blend' }))).toBe('separate')
    expect(batchClass(rec({ lampModel: true }))).toBe('lamp')
    expect(batchClass(rec({ emissive: true }))).toBe('lamp')
    expect(batchClass(rec({ model: { model: '', source: LAMP_SOURCE, kind: 'static' } }))).toBe('lamp')
    expect(batchClass(rec({ name: 'lantern_light' }), true)).toBe('lamp')
    expect(batchClass(rec({ name: 'lantern_light' }), false)).toBe('merge')
  })
})

describe('shadows: the batch brings its own proxy and cut-out casters (F10)', () => {
  it('ShadowProxies takes the batch proxy, keeps it out of disposal, and drops it with the owner', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => engine.dispose())
    const px = new ShadowProxies(scene, () => [])
    const proxy = MeshBuilder.CreateBox('proxy', { size: 4 }, scene)
    const leaf = MeshBuilder.CreateBox('leaf', { size: 1 }, scene)
    const mesh = MeshBuilder.CreateBox('batch', { size: 1 }, scene)
    const info: PlacedModelInfo = { index: 0, source: 'a.bsr', heightM: 3, isFoliage: false, kind: 'static' }
    px.placed(7, {} as WorldModel, info, [], [{ region: 1, group: 2 } as WorldPlacement])
    const v = px.version
    const batch: RegionBatch = {
      owner: 7, region: 1, meshes: [mesh], shadowProxy: proxy, cutoutCasters: [leaf], slots: [], min: Vector3.Zero(), max: Vector3.One(),
      setEmissive: () => {},
    }
    px.batched(7, batch)
    expect(px.version).toBeGreaterThan(v)
    expect(mesh.receiveShadows).toBe(true)
    expect([...px.allProxies()].map(p => p.mesh)).toContain(proxy)
    expect(px.cutouts()).toContain(leaf)
    px.removed(7)
    expect([...px.allProxies()]).toEqual([])
    expect(px.cutouts()).toEqual([])
    expect(proxy.isDisposed()).toBe(false) // the batch owns it
    px.dispose()
  })

  it('WorldShadows.addCasterSource: its casters join the list, a version bump refreshes it, the remover takes them out', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => engine.dispose())
    const sun = new DirectionalLight('sun', new Vector3(-1, -1, 0), scene)
    const host = { objects: { addRegionListener: () => () => {} }, terrain: { meshes: [] }, regions: { regions: [] }, addCommitStep: () => () => {} }
    const sh = new WorldShadows(scene, sun, host, { quality: RENDER_PRESETS.high })
    const caster = MeshBuilder.CreateBox('caster', { size: 1 }, scene)
    const src = { version: 0, casters: () => [caster] }
    const off = sh.addCasterSource(src)
    expect(sh.refreshCasters(Vector3.Zero())).toContain(caster)
    off()
    expect(sh.refreshCasters(Vector3.Zero())).not.toContain(caster)
    sh.dispose()
  })
})

describe('the geometry export (F13: dequantized, the node transform baked in)', () => {
  function quantizedModel(scene: Scene, scale: Vector3) {
    const container = new AssetContainer(scene)
    const root = new TransformNode('dequant', scene)
    root.position.set(10, 20, 30)
    root.scaling.copyFrom(scale)
    const mesh = new Mesh('prim0', scene)
    const engine = scene.getEngine()
    // KHR_mesh_quantization: normalised int16 positions and int8 normals, uint16 UVs; the node holds the scale/offset.
    mesh.setVerticesBuffer(new VertexBuffer(engine, new Int16Array([-32767, 0, 0, 32767, 0, 0, 0, 32767, 0]), VertexBuffer.PositionKind, { updatable: false, stride: 3, size: 3, type: VertexBuffer.SHORT, normalized: true }))
    mesh.setVerticesBuffer(new VertexBuffer(engine, new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127]), VertexBuffer.NormalKind, { updatable: false, stride: 3, size: 3, type: VertexBuffer.BYTE, normalized: true }))
    mesh.setVerticesBuffer(new VertexBuffer(engine, new Uint16Array([0, 0, 65535, 0, 0, 65535]), VertexBuffer.UVKind, { updatable: false, stride: 2, size: 2, type: VertexBuffer.UNSIGNED_SHORT, normalized: true }))
    mesh.setIndices([0, 1, 2])
    mesh.material = new PBRMaterial('mat', scene)
    mesh.parent = root
    scene.removeMesh(mesh)
    scene.removeTransformNode(root)
    container.meshes.push(mesh)
    container.transformNodes.push(root)
    container.rootNodes.push(root)
    return { container, mesh }
  }

  it('positions equal the rendered world positions of the quantized mesh; normals unit; UVs in [0, 1]; indices uint32', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    cleanups.push(() => engine.dispose())
    const { container, mesh } = quantizedModel(scene, new Vector3(2, 3, 4))
    const prep = prepareStatic(container)
    const g = extractModelGeometry(prep)
    expect(g.primitives).toHaveLength(1)
    const p = g.primitives[0]!
    const world = mesh.computeWorldMatrix(true)
    const raw = mesh.getVerticesData(VertexBuffer.PositionKind)!
    for (let v = 0; v < 3; v++) {
      const w = Vector3.TransformCoordinates(Vector3.FromArray(raw, v * 3), world)
      expect([p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2]].map(x => +x!.toFixed(3))).toEqual([w.x, w.y, w.z].map(x => +x.toFixed(3)))
    }
    expect([...p.positions.slice(0, 3)].map(x => +x.toFixed(3))).toEqual([8, 20, 30])
    expect([...p.positions.slice(3, 6)].map(x => +x.toFixed(3))).toEqual([12, 20, 30])
    for (let v = 0; v < 3; v++) expect(Math.hypot(p.normals![v * 3]!, p.normals![v * 3 + 1]!, p.normals![v * 3 + 2]!)).toBeCloseTo(1, 5)
    expect([...p.uvs!]).toEqual([0, 0, 1, 0, 0, 1])
    expect(p.uvs2).toBeNull()
    expect(p.indices).toBeInstanceOf(Uint32Array)
    expect([...p.indices]).toEqual([0, 1, 2])
    expect(p.mirrored).toBe(false)
    expect(p.material).toBe(mesh.material)
    expect(g.vertices).toBe(3)
    expect(g.triangles).toBe(1)
    // A mirroring node transform is reported (the merge flips those triangles).
    const mirrored = quantizedModel(scene, new Vector3(-1, 1, 1))
    expect(extractModelGeometry(prepareStatic(mirrored.container)).primitives[0]!.mirrored).toBe(true)
    // Normals follow the inverse transpose: a non-uniform scale keeps them perpendicular.
    const n = Vector3.TransformNormal(new Vector3(0, 0, 1), Matrix.Invert(world).transpose()).normalize()
    expect(p.normals![2]).toBeCloseTo(n.z, 5)
  })

  it('geometryOf extracts once per cached model; tagged meshes are left out', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => engine.dispose())
    const { container } = quantizedModel(scene, Vector3.One())
    const extra = MeshBuilder.CreateBox('grassTagged', { size: 1 }, scene)
    extra.metadata = { sroWorld: 'scatter' }
    scene.removeMesh(extra)
    container.meshes.push(extra)
    const prep = prepareStatic(container)
    const entry = { prep, geometry: undefined as ReturnType<typeof geometryOf> | undefined }
    const a = geometryOf(entry)
    expect(a).not.toBeNull()
    expect(geometryOf(entry)).toBe(a)
    expect(geometryOf({ prep })).toBe(a)
    expect(a!.primitives.map(p => p.name)).toEqual(['prim0'])
    expect(geometryOf({ prep: null })).toBeNull()
  })
})

describe('material batch records', () => {
  it('every convert() returns one record per material, found again by batchRecord', async () => {
    const s = await world({ render: 'pbr' })
    const mats = s.world.materials
    const container = new AssetContainer(s.scene)
    const src = new PBRMaterial('wall', s.scene)
    s.scene.removeMaterial(src)
    const box = MeshBuilder.CreateBox('b', { size: 1 }, s.scene)
    s.scene.removeMesh(box)
    box.material = src
    container.meshes.push(box)
    container.materials.push(src)
    const converted = await mats.convert(container, { materials: [{ name: 'wall', flags: 0, diffuse: [], ambient: [], texture: 'res\\wall.ddj', alphaMode: 'OPAQUE' }] }, false, { model: 'm.glb', source: 'res\\x\\wall.bsr', kind: 'static' })
    expect(converted.records).toHaveLength(converted.materials.length)
    const r = converted.records[0]!
    expect(r.material).toBe(converted.materials[0])
    expect(mats.batchRecord(r.material)).toBe(r)
    expect([r.path, r.name, r.texture, r.alpha, r.unlit, r.lampModel, r.emissive]).toEqual(['pbr', 'wall', 'res\\wall.ddj', 'opaque', false, false, false])
    expect(r.cls).not.toBeNull()
    expect(batchClass(r)).toBe('merge')
    mats.release(converted)
  })
})
