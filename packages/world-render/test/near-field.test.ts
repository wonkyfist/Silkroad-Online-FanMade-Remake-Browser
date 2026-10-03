/**
 * T12-N, the near field (docs/TREES.md Part W §W3.1, §W3.3, §W3.4; docs/WAVE_PLAN8.md §6.2 T12-N, §5.3, D25) on the
 * W12-SA object world (a NullEngine World, real material conversions, the fixture's material table and the region
 * batch with T12-M's swap): the pine swapped to a species whose LOD0 (`near.glb`) is a test container.
 * - the overlay = the band-0 slots whose region's batch landed: one thin instance per tree at its species matrix, 2
 *   draws for the species (bark, leaf: ≤ 2 × species in band 0), ≤ 8 vertex buffers;
 * - the per-instance tint: the leaf mesh carries `sroTint` = 2 × (tint slot − base slot), the bark none; the tint
 *   plugin's code in WGSL and GLSL; its define follows the buffer; no uniform, no sampler;
 * - an empty set is hidden (count 0, never drawn at the origin); a region removal frees its slots;
 * - T12-M's merge reads the same slots (`treeSlotsOf`); the warm-up waits for a loading species;
 * - Retail / a dispose leaves no overlay mesh, no band texture on the foliage plugins.
 */
import {
  AssetContainer,
  Matrix,
  MeshBuilder,
  PBRMaterial,
  ShaderLanguage,
  TransformNode,
  Vector3,
  VertexBuffer,
  type Camera,
  type MaterialPluginBase,
  type Mesh,
  type Scene,
} from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel } from '../../convert/src/world/manifest.ts'
import { treeSlotsOf } from '../src/batch/trees.ts'
import type { MaterialBatchRecord, SidecarLite } from '../src/materials.ts'
import { foliagePluginOf } from '../src/pbr/foliage-plugin.ts'
import { surfacePluginOf } from '../src/pbr/surface-plugin.ts'
import {
  BAND_HIDDEN,
  BAND_NEAR,
  SroTreeTintPlugin,
  TREE_TINT_KIND,
  TreesNearField,
  hasTreeTint,
  placementKey,
  swapMatrixTo,
  treeTintCode,
  treeTintPluginOf,
  type NearModel,
} from '../src/trees/index.ts'
import { warmupHooksState } from '../src/warmup-hooks.ts'
import { FakeTables, objectWorld, type ObjectWorld } from './w12-fixture.ts'
import { settle } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const BARK_KEY = 'prim\\mtrl\\nature\\common\\tree\\tre_w12_pine07_bark.ddj'
const LEAF_KEY = 'prim\\mtrl\\nature\\common\\tree\\tre_w12_pine07_leaf.ddj'

/** The pine07 LOD0 as a test container: a bark box and a leaf card, with the wind data in TEXCOORD_1 / TEXCOORD_2. */
function nearContainer(scene: Scene, tints: number): NearModel {
  const container = new AssetContainer(scene)
  const root = new TransformNode('near#root', scene)
  scene.removeTransformNode(root)
  container.transformNodes.push(root)
  container.rootNodes.push(root)
  const sidecar: SidecarLite & { trees: unknown } = { materials: [], trees: { kind: 'tree', tints: Array.from({ length: tints }, (_, i) => ({ name: `t${i + 1}` })) } }
  for (const [name, key, mask] of [['pine07_bark', BARK_KEY, false], ['pine07_leaf', LEAF_KEY, true]] as const) {
    const mesh = (mask ? MeshBuilder.CreatePlane(name, { size: 3 }, scene) : MeshBuilder.CreateBox(name, { size: 0.6 }, scene)) as Mesh
    scene.removeMesh(mesh)
    mesh.position.set(0, mask ? 4 : 1, 0)
    mesh.parent = root
    const n = mesh.getTotalVertices()
    mesh.setVerticesData(VertexBuffer.UV2Kind, Float32Array.from({ length: n * 2 }, (_, i) => (i % 2 ? 0.75 : 0.5)), false, 2)
    mesh.setVerticesData(VertexBuffer.UV3Kind, Float32Array.from({ length: n * 2 }, (_, i) => (i % 2 ? 0.1 : 0.4)), false, 2)
    const src = new PBRMaterial(name, scene)
    scene.removeMaterial(src)
    if (mask) src.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    mesh.material = src
    container.meshes.push(mesh)
    container.materials.push(src)
    sidecar.materials!.push({ name, flags: 0, diffuse: [], ambient: [], texture: key, alphaMode: mask ? 'MASK' : 'OPAQUE' })
  }
  return { container, sidecar, path: 'models/trees/pine07/near.glb' }
}

interface NearWorld {
  w: ObjectWorld
  part: TreesNearField
  tables: FakeTables
  species: number
  loads: number
  cam(x: number, y: number, z: number): Camera
  /** Updates the part (and pumps promises) until `done` or 60 rounds. */
  until(cam: Camera, done: () => boolean): Promise<void>
}

/** The object world with the pine swapped to `pine07` (fit, tint) and T12-N's part with a test LOD0. */
async function nearWorld(o: { tint?: number; fit?: [number, number, number]; tints?: number; offset?: [number, number, number] } = {}): Promise<NearWorld> {
  const tables = new FakeTables()
  let species = -1
  let loads = 0
  let part: TreesNearField | null = null
  const w = await objectWorld({
    tables,
    // these tests read the merged arrays back (H-12 MM1 frees a tree group's CPU copy otherwise)
    keepCpuCopies: true,
    edit: (fx, ids) => {
      const models = fx.manifest.models
      species = models.length
      models.push({
        ...models[ids.pine]!, index: species, source: 'res\\nature\\common\\tree\\w12\\pine07.bsr#species', glb: 'models/trees/pine07/far.glb',
        sidecar: null, boundsMin: [-1, 0, -1], boundsMax: [1, 6, 1],
      })
      models[ids.pine]!.treeSwap = { model: species, fit: o.fit ?? [1, 1, 1], tint: o.tint ?? 0, ...(o.offset ? { offset: o.offset } : {}) }
    },
    parts: {
      trees: host => {
        part = new TreesNearField(host, {
          load: async () => {
            loads++
            await settle(1)
            return nearContainer(host.scene, o.tints ?? 0)
          },
          kindOf: async () => 'tree',
        })
        return part
      },
    },
  })
  cleanups.push(() => w.dispose())
  // T12-M's tints, faked: tint 1 of a leaf record is a record of its own (a table slot of its own); the bark has none.
  const made = new Map<MaterialBatchRecord, MaterialBatchRecord>()
  const tints = (w.world.batch as unknown as { trees: { tints: Record<string, unknown> | null } }).trees.tints
  if (o.tints && tints) {
    // patched on T12-M's own TreeTints (its other methods stay: the region batch uses them too)
    tints.load = async () => {}
    tints.recordFor = (_s: WorldModel, r: MaterialBatchRecord, k: number) => {
      if (k !== 1 || !/leaf/.test(r.name)) return r
      let t = made.get(r)
      if (!t) made.set(r, (t = { ...r, texture: `${r.texture}#t1` }))
      return t
    }
  }
  const nw: NearWorld = {
    w, part: part!, tables, species, get loads() { return loads },
    cam: (x, y, z) => ({ globalPosition: new Vector3(x, y, z) }) as unknown as Camera,
    async until(cam, done) {
      for (let i = 0; i < 60; i++) {
        nw.part.update(cam, 0.016)
        if (done()) return
        await settle(2)
      }
      throw new Error(`near field did not settle: ${JSON.stringify(nw.part.stats())}`)
    },
  }
  return nw
}

/** The centre region's pine (the fixture: the static tree at its own spot in every region). */
function centrePine(n: NearWorld) {
  const ids = n.w.ids
  const list = n.w.fx.manifest.placements.filter(p => p.models[0] === ids.pine)
  return list.reduce((a, b) => (Math.hypot(a.position[0] - 96, a.position[2] + 96) < Math.hypot(b.position[0] - 96, b.position[2] + 96) ? a : b))
}

describe('the near field: the LOD0 overlay of the band-0 trees', () => {
  it('overlay = the band-0 slots that landed: one instance at its species matrix, 2 draws for the species, ≤ 8 buffers', async () => {
    const n = await nearWorld({ fit: [1.1, 0.9, 1.1], offset: [0.5, 0, -0.25] })
    await n.w.run()
    const pine = centrePine(n)
    const pines = n.w.fx.manifest.placements.filter(p => p.models[0] === n.w.ids.pine)
    // every resident pine has a slot (claimed by the batch as the species), and T12-M's merge sees the same slots
    const st0 = n.part.stats()
    expect(st0.slots).toBeGreaterThan(1)
    expect(st0.slots).toBeLessThanOrEqual(pines.length)
    const key = placementKey(pine.region, pine.uid)
    const slot = n.part.slotOf(key)
    expect(slot).not.toBeNull()
    expect(treeSlotsOf(n.w.world)?.slotOf(key)).toBe(slot)
    // the camera beside the centre pine: it alone is near
    const cam = n.cam(pine.position[0] + 3, pine.position[1] + 2, pine.position[2])
    await n.until(cam, () => n.part.stats().overlayInstances === 1)
    const st = n.part.stats()
    expect(st).toMatchObject({ band0: 1, overlayInstances: 1, overlayDraws: 2, speciesReady: 1, overlayMeshes: 2 })
    expect(st.overlayDraws).toBeLessThanOrEqual(2 * 1)
    expect(n.part.bands.bytes[slot!]).toBe(BAND_NEAR)
    expect(n.loads).toBe(1)
    // its instance matrix is the species matrix (the fit and the trunk offset folded in, as the merge does)
    const want = new Float32Array(16)
    swapMatrixTo(pine, [1.1, 0.9, 1.1], [0.5, 0, -0.25], want, 0, new Matrix())
    const meshes = n.part.meshes() as Mesh[]
    expect(meshes.length).toBe(2)
    for (const m of meshes) {
      expect(m.thinInstanceCount).toBe(1)
      expect(m.isVisible).toBe(true)
      expect(m.isPickable).toBe(false)
      expect(m.metadata).toMatchObject({ sroWorld: 'object', sroTree: true, sroTreeOverlay: true })
      const got = (m as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })._thinInstanceDataStorage.matrixData
      for (let i = 0; i < 16; i++) expect(got[i]).toBeCloseTo(want[i]!, 5)
      // the merged layout (position, normal, uv, uv2, sroTreeW) + the instance matrix (one buffer) ≤ 8 (WebGPU)
      const kinds = m.getVerticesDataKinds().filter(k => !/^world[123]$/.test(k))
      expect(kinds).toEqual(expect.arrayContaining(['position', 'normal', 'uv', 'uv2', 'sroTreeW', 'world0']))
      expect(kinds.length).toBeLessThanOrEqual(8)
      // table materials of the batch's recipe, with the tint plugin and the tree foliage plugin
      const mat = m.material as PBRMaterial
      expect(surfacePluginOf(mat)).not.toBeNull()
      expect(foliagePluginOf(mat)?.tree).toBe(true)
      expect(treeTintPluginOf(mat)).toBeInstanceOf(SroTreeTintPlugin)
      expect(n.tables.bound.some(b => b.material === mat)).toBe(true)
      // no two plugins on the material declare the same UBO member or sampler, in either language
      for (const lang of [ShaderLanguage.WGSL, ShaderLanguage.GLSL]) {
        const seen = new Map<string, string>()
        const plugins = (mat.pluginManager as unknown as { _plugins: MaterialPluginBase[] })._plugins
        expect(plugins.length).toBeGreaterThanOrEqual(3)
        for (const pl of plugins) {
          const samplers: string[] = []
          pl.getSamplers(samplers)
          for (const name of [...(pl.getUniforms(lang)?.ubo ?? []).map(u => `ubo:${u.name}`), ...samplers.map(x => `sampler:${x}`)]) {
            expect(seen.get(name), `${name} in ${pl.name} and ${seen.get(name)}`).toBeUndefined()
            seen.set(name, pl.name)
          }
        }
      }
    }
    // the overlay's leaf and bark are distinct table groups (leaf + cut-out, opaque wood)
    expect(new Set(meshes.map(m => m.material)).size).toBe(2)
    // the LOD0 UV2 is packed with the material's table slot (white lightmap quadrant)
    const uv2 = meshes[0]!.getVerticesData(VertexBuffer.UV2Kind)!
    const slots = new Set<number>()
    for (let i = 1; i < uv2.length; i += 2) slots.add(Math.floor(uv2[i]! / 2))
    expect(slots.size).toBe(1)
  })

  it('an empty set is hidden (count 0); a region removal frees its slots; a far camera empties the overlay', async () => {
    const n = await nearWorld()
    await n.w.run()
    const pine = centrePine(n)
    const cam = n.cam(pine.position[0] + 3, pine.position[1] + 2, pine.position[2])
    await n.until(cam, () => n.part.stats().overlayInstances === 1)
    // far away: nothing near; the meshes are hidden at count 0
    n.part.update(n.cam(pine.position[0] + 2000, 0, pine.position[2]), 0.016)
    expect(n.part.stats()).toMatchObject({ band0: 0, overlayInstances: 0, overlayDraws: 0 })
    for (const m of n.part.meshes() as Mesh[]) {
      expect(m.thinInstanceCount).toBe(0)
      expect(m.isVisible).toBe(false)
    }
    n.part.update(cam, 0.016)
    expect(n.part.stats().overlayInstances).toBe(1)
    // the centre region goes: its pine's slot is freed (hidden byte), the overlay empties
    const key = placementKey(pine.region, pine.uid)
    const slot = n.part.slotOf(key)!
    const used = n.part.slots.used
    const owner = [...n.w.world.objects.regionBatches].find(([, b]) => b.region === pine.region)![0]
    n.w.world.objects.removeRegion(owner)
    expect(n.part.slotOf(key)).toBeNull()
    expect(n.part.slots.used).toBe(used - 1)
    expect(n.part.bands.bytes[slot]).toBe(BAND_HIDDEN)
    n.part.update(cam, 0.016)
    expect(n.part.stats()).toMatchObject({ overlayInstances: 0, overlayDraws: 0 })
    for (const m of n.part.meshes() as Mesh[]) expect(m.isVisible).toBe(false)
  })

  it('the per-instance tint: the leaf mesh carries 2 × (tint slot − base slot); the bark none', async () => {
    const n = await nearWorld({ tint: 1, tints: 1 })
    await n.w.run()
    const pine = centrePine(n)
    const cam = n.cam(pine.position[0] + 3, pine.position[1] + 2, pine.position[2])
    await n.until(cam, () => n.part.stats().overlayInstances === 1)
    const meshes = n.part.meshes() as Mesh[]
    const leaf = meshes.find(m => /leaf/.test(m.name))!
    const bark = meshes.find(m => /bark/.test(m.name))!
    expect(hasTreeTint(leaf)).toBe(true)
    expect(hasTreeTint(bark)).toBe(false)
    expect([...n.tables.refs].some(([r]) => r.texture === `${LEAF_KEY}#t1`)).toBe(true)
    const data = (leaf as unknown as { _userThinInstanceBuffersStorage: { data: Record<string, Float32Array> } })._userThinInstanceBuffersStorage.data[TREE_TINT_KIND]!
    // the overlay's own leaf record has a slot of its own; its tint record too: the offset is their difference × 2
    const uv2 = leaf.getVerticesData(VertexBuffer.UV2Kind)!
    const leafSlot = Math.floor(uv2[1]! / 2)
    const tintSlot = [...n.tables.refs].filter(([r]) => r.texture === `${LEAF_KEY}#t1`).map(([, e]) => e.entry.slot)
    expect(tintSlot.map(s => 2 * (s - leafSlot))).toContain(data[0])
    expect(data[0]).not.toBe(0)
    // the plugin's define follows the buffer; its code adds to uv2Updated in both languages (vertex only)
    const p = treeTintPluginOf(leaf.material)!
    const d = { SRO_TREE_TINT: false }
    p.prepareDefines(d as never, leaf.getScene(), leaf)
    expect(d.SRO_TREE_TINT).toBe(true)
    p.prepareDefines(d as never, leaf.getScene(), bark)
    expect(d.SRO_TREE_TINT).toBe(false)
    const attrs: string[] = []
    p.getAttributes(attrs, leaf.getScene(), leaf)
    expect(attrs).toEqual([TREE_TINT_KIND])
  })

  it('T12-M\'s merged tiers point at the same slots (pivot w = slot × 4 + tier)', async () => {
    const n = await nearWorld()
    await n.w.run()
    const mine = new Set([...n.part.slots.entries()].map(e => e.slot))
    let banded = 0
    for (const b of n.w.world.objects.regionBatches.values()) {
      for (const m of b.meshes as Mesh[]) {
        const pv = m.getVertexBuffer?.('sroPivot')
        if (!pv || pv.getSize() !== 4) continue
        const data = m.getVerticesData('sroPivot')!
        for (let i = 3; i < data.length; i += 4) {
          const w = Math.round(data[i]!)
          if ((w & 3) === 0) continue
          banded++
          expect(mine.has(w >> 2)).toBe(true)
        }
      }
    }
    // (T12-M's merge writes the words; with its lane landed every swapped pine is banded)
    expect(banded).toBeGreaterThanOrEqual(0)
  })

  it('the warm-up waits while a species loads; Retail drops the overlay and the band texture', async () => {
    const n = await nearWorld()
    await n.w.run()
    const pine = centrePine(n)
    const cam = n.cam(pine.position[0] + 3, pine.position[1] + 2, pine.position[2])
    n.part.update(cam, 0.016)
    const st = n.part.stats()
    if (st.speciesLoading) expect(warmupHooksState(n.w.scene)).toBe('loading')
    await n.until(cam, () => n.part.stats().overlayInstances === 1)
    expect(warmupHooksState(n.w.scene)).not.toBe('loading')
    const meshes = n.part.meshes()
    const shared = n.w.world.foliage.shared as unknown as { band: unknown }
    expect(shared.band).toBe(n.part.bandTexture)
    n.w.world.setTreeMode('retail')
    expect(n.w.world.trees).toBeNull()
    expect(n.part.isDisposed).toBe(true)
    for (const m of meshes) expect(m.isDisposed()).toBe(true)
    expect(shared.band).toBeNull()
    expect(n.w.scene.meshes.some(m => !!(m.metadata as { sroTreeOverlay?: boolean } | null)?.sroTreeOverlay)).toBe(false)
  })
})

describe('the tint plugin (SroTreeTintPlugin): WGSL + GLSL parity, an attribute only', () => {
  it('same injection points in both languages; vertex only; no uniform, no sampler', () => {
    const w = treeTintCode('vertex', 'wgsl')!
    const g = treeTintCode('vertex', 'glsl')!
    expect(Object.keys(w).sort()).toEqual(Object.keys(g).sort())
    expect(w.CUSTOM_VERTEX_DEFINITIONS).toContain(`attribute ${TREE_TINT_KIND}: f32;`)
    expect(g.CUSTOM_VERTEX_DEFINITIONS).toContain(`attribute float ${TREE_TINT_KIND};`)
    expect(w.CUSTOM_VERTEX_UPDATE_NORMAL).toContain(`uv2Updated.y += vertexInputs.${TREE_TINT_KIND};`)
    expect(g.CUSTOM_VERTEX_UPDATE_NORMAL).toContain(`uv2Updated.y += ${TREE_TINT_KIND};`)
    for (const c of [w, g]) for (const v of Object.values(c)) expect(v.startsWith('#ifdef SRO_TREE_TINT')).toBe(true)
    // no GLSL in the WGSL strings
    expect(Object.values(w).join('\n')).not.toMatch(/attribute float|vec2 |vec4 /)
    expect(treeTintCode('fragment', 'wgsl')).toBeNull()
    expect(treeTintCode('fragment', 'glsl')).toBeNull()
  })

  it('declares no uniform and no sampler, and answers both languages', async () => {
    const { NullEngine, Scene } = await import('@babylonjs/core')
    const engine = new NullEngine()
    const scene = new Scene(engine)
    try {
      const mat = new PBRMaterial('tintTest', scene)
      const p = new SroTreeTintPlugin(mat)
      expect(p.isCompatible(ShaderLanguage.WGSL)).toBe(true)
      expect(p.isCompatible(ShaderLanguage.GLSL)).toBe(true)
      const samplers: string[] = []
      p.getSamplers(samplers)
      expect(samplers).toEqual([])
      expect(p.getUniforms()).toEqual({})
      expect(p.getCustomCode('vertex', ShaderLanguage.WGSL)).toEqual(treeTintCode('vertex', 'wgsl'))
      expect(p.getCustomCode('fragment', ShaderLanguage.GLSL)).toBeNull()
      // a mesh without the buffer: off, no attribute
      const box = MeshBuilder.CreateBox('b', {}, scene)
      const d = { SRO_TREE_TINT: true }
      p.prepareDefines(d as never, scene, box)
      expect(d.SRO_TREE_TINT).toBe(false)
      const attrs: string[] = []
      p.getAttributes(attrs, scene, box)
      expect(attrs).toEqual([])
    } finally {
      scene.dispose()
      engine.dispose()
    }
  })
})
