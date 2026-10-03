/**
 * T12-E, the World Editor's tree seam (docs/TREES.md Part W §W3.9, WF14; docs/WAVE_PLAN8.md §6.2 T12-E, D16, D17) on the
 * W12-SA object world (a NullEngine World, the region batch with T12-M's swap, T12-N's trees part with a test LOD0):
 * - library(): the file's rows resolved against the manifest (carrier, species, placeable or why not); a species the
 *   file lacks is still listed (derived: the closest-envelope carrier); every species of the real export is placeable;
 * - preview(): hides the merged copy (band 3) and shows one overlay instance at the dragged matrix (fit and offset
 *   folded in); the drop re-merges the region (S-OBJ) and the tree stands at its new spot; a revert restores it;
 * - setHidden(): a delete holds the merged copy hidden until the re-merge without it lands;
 * - no trees part (Classic, 'retail'): nothing claims, nothing previews.
 */
import { existsSync, readFileSync } from 'node:fs'
import { AssetContainer, Matrix, MeshBuilder, PBRMaterial, TransformNode, Vector3, VertexBuffer, type Camera, type Mesh, type Scene } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldManifest, WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import type { SidecarLite } from '../src/materials.ts'
import {
  TREE_LIBRARY_FORMAT,
  TreePreview,
  closestCarrier,
  parseTreeLibrary,
  resolveTreeLibrary,
  setTreeLibrary,
  swappedCarrierOf,
  treeLibraryOf,
  treePreviewMatrix,
} from '../src/trees/editor.ts'
import { BAND_HIDDEN, BAND_NEAR, TreesNearField, placementKey, swapMatrixTo, type NearModel } from '../src/trees/index.ts'
import { settle } from './stream-fixture.ts'
import { CX, CZ, objectWorld, pumpUntil, type ObjectWorld } from './w12-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const REPO = new URL('../../../', import.meta.url)
const CENTRE_ID = (CZ << 8) | CX

/** A minimal LOD0 container (a bark box and a leaf card). */
function nearContainer(scene: Scene): NearModel {
  const container = new AssetContainer(scene)
  const root = new TransformNode('near#root', scene)
  scene.removeTransformNode(root)
  container.transformNodes.push(root)
  container.rootNodes.push(root)
  const sidecar: SidecarLite & { trees: unknown } = { materials: [], trees: { kind: 'tree', tints: [] } }
  for (const [name, mask] of [['pine07_bark', false], ['pine07_leaf', true]] as const) {
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
      name, flags: 0, diffuse: [], ambient: [], alphaMode: mask ? 'MASK' : 'OPAQUE',
      texture: `prim\\mtrl\\nature\\common\\tree\\tre_w12_${name}.ddj`,
    })
  }
  return { container, sidecar, path: 'models/trees/pine07/near.glb' }
}

const FIT: [number, number, number] = [1.1, 0.9, 1.1]
const OFFSET: [number, number, number] = [0.5, 0, -0.25]

interface EdWorld {
  w: ObjectWorld
  part: TreesNearField
  species: number
  cam: Camera
  pine: WorldPlacement
  key: number
  /** Updates the part (pumping promises) until `done`. */
  until(done: () => boolean): Promise<void>
  /** The overlay's instance matrices (16 floats each) of the first overlay mesh. */
  instances(): Float32Array[]
  /** The centre region's own placements with `edit` applied to the centre pine (null: deleted). */
  list(edit: (p: WorldPlacement) => WorldPlacement | null): WorldPlacement[]
}

async function edWorld(): Promise<EdWorld> {
  let species = -1
  let part: TreesNearField | null = null
  const w = await objectWorld({
    edit: (fx, ids) => {
      const models = fx.manifest.models
      species = models.length
      models.push({
        ...models[ids.pine]!, index: species, source: 'res\\nature\\common\\tree\\w12\\pine07.bsr#species', glb: 'models/trees/pine07/far.glb',
        sidecar: null, boundsMin: [-1, 0, -1], boundsMax: [1, 6, 1],
      })
      models[ids.pine]!.treeSwap = { model: species, fit: FIT, tint: 0, offset: OFFSET }
    },
    parts: {
      trees: host => {
        part = new TreesNearField(host, {
          load: async () => {
            await settle(1)
            return nearContainer(host.scene)
          },
          kindOf: async () => 'tree',
        })
        return part
      },
    },
  })
  cleanups.push(() => w.dispose())
  await w.run()
  const pines = w.fx.manifest.placements.filter(p => p.models[0] === w.ids.pine && p.region === CENTRE_ID)
  expect(pines.length).toBe(1)
  const pine = pines[0]!
  const cam = { globalPosition: new Vector3(pine.position[0] + 3, pine.position[1] + 2, pine.position[2]) } as unknown as Camera
  const e: EdWorld = {
    w, part: part!, species, cam, pine, key: placementKey(pine.region, pine.uid),
    async until(done) {
      for (let i = 0; i < 80; i++) {
        e.part.update(cam, 0.016)
        if (done()) return
        await settle(2)
      }
      throw new Error(`trees part did not settle: ${JSON.stringify(e.part.stats())}`)
    },
    instances() {
      const m = e.part.meshes()[0] as Mesh | undefined
      if (!m || !m.isVisible) return []
      const data = (m as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array | null } })._thinInstanceDataStorage.matrixData
      const out: Float32Array[] = []
      for (let k = 0; k < m.thinInstanceCount; k++) out.push(data!.slice(k * 16, k * 16 + 16))
      return out
    },
    list(edit) {
      const out: WorldPlacement[] = []
      for (const p of w.fx.manifest.placements) {
        if (p.region !== CENTRE_ID) continue
        const q = p === pine ? edit(p) : p
        if (q) out.push(q)
      }
      return out
    },
  }
  await e.until(() => e.part.stats().overlayInstances === 1)
  return e
}

const expectMatrix = (got: ArrayLike<number> | undefined, want: ArrayLike<number>) => {
  expect(got).toBeDefined()
  for (let i = 0; i < 16; i++) expect(got![i]).toBeCloseTo(want[i]!, 4)
}

/** The species matrix of a placement (as the merge folds it). */
const speciesMatrix = (p: Pick<WorldPlacement, 'position' | 'rotation' | 'scale'>) => {
  const m = new Float32Array(16)
  swapMatrixTo(p, FIT, OFFSET, m, 0, new Matrix())
  return m
}

/** A node-like world matrix (T · R · S) of a placement. */
const worldMatrix = (p: Pick<WorldPlacement, 'position' | 'rotation' | 'scale'>) => {
  const m = new Float32Array(16)
  swapMatrixTo(p, [1, 1, 1], null, m, 0, new Matrix())
  return m
}

describe('T12-E library(): the Trees tab from content/trees/library.json, resolved against the export', () => {
  const row = (id: string, carrier: string) => ({
    id, name: id.toUpperCase(), family: 'pine', kind: 'tree', carrier, heightM: 10, widthM: 6, scaleRange: [0.85, 1.15], tint: 'default', tints: ['default'], thumbnail: `trees/${id}/thumb.png`,
  })
  const model = (index: number, source: string, extra: Partial<WorldModel> = {}): WorldModel => ({
    index, source, glb: `models/m${index}.glb`, sidecar: null, kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: [],
    boundsMin: [-1, 0, -1], boundsMax: [1, 5, 1], bytes: 1, validatorErrors: 0, ...extra,
  } as unknown as WorldModel)

  it('rows resolve to carrier + species; a wrong or missing carrier is named; a species the file lacks is derived', () => {
    const manifest = {
      models: [
        model(0, 'res\\nature\\common\\tree\\tre_pine07_04.bsr', { treeSwap: { model: 3, fit: [1.2, 1.1, 1.2], tint: 0 } }),
        model(1, 'res\\nature\\common\\tree\\tre_pine07_02.bsr', { treeSwap: { model: 3, fit: [1.02, 0.98, 1.02], tint: 0 } }),
        model(2, 'res\\nature\\common\\tree\\tre_maple03.bsr', { treeSwap: { model: 4, fit: [1, 1, 1], tint: 0 } }),
        model(3, 'res\\nature\\common\\tree\\w12\\pine07.bsr#species', { glb: 'models/trees/pine07/far.glb' }),
        model(4, 'res\\nature\\common\\tree\\w12\\maple03.bsr#species', { glb: 'models/trees/maple03/far.glb' }),
        model(5, 'res\\bldg\\china\\wall.bsr'),
      ],
    } as Pick<WorldManifest, 'models'>
    const { rows, problems } = parseTreeLibrary({
      format: TREE_LIBRARY_FORMAT, version: 1,
      species: [row('pine07', 'res/nature/common/tree/TRE_PINE07_04.bsr'), row('willow03', 'res\\nature\\common\\tree\\tre_willow03.bsr'), row('bad', 'res\\bldg\\china\\wall.bsr'), { id: 'x' }],
    })
    expect(problems).toEqual(['species[3]: needs an id and a carrier'])
    const lib = resolveTreeLibrary(rows, manifest)
    expect(lib.map(e => [e.id, e.placeable, e.derived])).toEqual([
      ['pine07', true, false], ['willow03', false, false], ['bad', false, false], ['maple03', true, true],
    ])
    const pine = lib[0]!
    expect(pine).toMatchObject({ name: 'PINE07', carrierModel: 0, speciesModel: 3, size: [0.85, 1.15], tint: null, thumbnail: 'trees/pine07/thumb.png', kind: 'tree' })
    expect(pine.carrier).toBe(manifest.models[0]!.source)
    expect([...pine.sources].sort()).toEqual([0, 1])
    expect(lib[1]!.problem).toMatch(/not in this export/)
    expect(lib[2]!.problem).toMatch(/not in this export yet/)
    expect(lib[3]).toMatchObject({ carrierModel: 2, speciesModel: 4, name: 'maple03', placeable: true })
    // the derived carrier is the closest envelope
    expect(closestCarrier([manifest.models[0]!, manifest.models[1]!])?.index).toBe(1)
    // World.trees.library() reads the same list once handed in
    // (before the file: every species of the manifest, derived; after: the file's names)
    expect(treeLibraryOf(manifest).map(e => [e.id, e.derived, e.placeable])).toEqual([['pine07', true, true], ['maple03', true, true]])
    expect(treeLibraryOf(manifest)[0]!.carrierModel).toBe(1)
    setTreeLibrary(manifest, { format: TREE_LIBRARY_FORMAT, version: 1, species: [row('pine07', manifest.models[0]!.source)] })
    expect(treeLibraryOf(manifest).map(e => [e.id, e.name, e.derived])).toEqual([['pine07', 'PINE07', false], ['maple03', 'maple03', true]])
  })

  it('content/trees/library.json parses clean; with the real export every species is placeable', () => {
    const file = JSON.parse(readFileSync(new URL('content/trees/library.json', REPO), 'utf8'))
    const { rows, problems } = parseTreeLibrary(file)
    expect(problems).toEqual([])
    expect(rows.length).toBeGreaterThanOrEqual(4)
    for (const r of rows) {
      expect(r.scaleRange[0]).toBeGreaterThanOrEqual(0.85)
      expect(r.scaleRange[1]).toBeLessThanOrEqual(1.15)
    }
    const at = new URL('work/out/world/jangan-fields/manifest.json', REPO)
    if (!existsSync(at)) return
    const manifest = JSON.parse(readFileSync(at, 'utf8')) as WorldManifest
    const lib = resolveTreeLibrary(rows, manifest)
    const species = manifest.models.filter(m => /#species$/i.test(m.source))
    expect(species.length).toBeGreaterThan(0)
    for (const sp of species) {
      const e = lib.find(x => x.speciesModel === sp.index)
      expect(e, sp.source).toBeDefined()
      expect(e!.problem, e!.id).toBeNull()
      // the carrier draws exactly this species
      const carrier = manifest.models[e!.carrierModel!]!
      expect(swappedCarrierOf(manifest, { models: [carrier.index] })?.treeSwap?.model).toBe(sp.index)
    }
  })
})

describe('T12-E preview() / setHidden(): the drag, the drop, the revert, the delete', () => {
  it('preview hides the merged copy (band 3) and shows one overlay instance at the dragged matrix', async () => {
    const e = await edWorld()
    const { w, part, pine, key } = e
    const slot = part.slotOf(key)!
    expect(part.bands.bytes[slot]).toBe(BAND_NEAR)
    expectMatrix(e.instances()[0], speciesMatrix(pine))
    const carrier = w.world.manifest.models[w.ids.pine]!
    const tp = new TreePreview(w.world)
    expect(tp.claims(carrier)).toBe(true)
    expect(tp.claims(w.world.manifest.models[0])).toBe(false)
    const moved = { ...pine, position: [pine.position[0] + 2, pine.position[1], pine.position[2] - 1] as [number, number, number] }
    let src = worldMatrix(moved)
    expect(tp.begin(key, carrier, () => src)).toBe(true)
    expect(tp.species).toBe('pine07')
    // a second preview at once is refused (the overlay draws one preview instance)
    expect(tp.begin(null, carrier, () => src)).toBe(false)
    part.update(e.cam, 0.016)
    expect(part.bands.bytes[slot]).toBe(BAND_HIDDEN)
    expect(part.stats()).toMatchObject({ previews: 1, overlayInstances: 1, band3: 1 })
    expectMatrix(e.instances()[0], speciesMatrix(moved))
    expectMatrix(e.instances()[0], treePreviewMatrix(carrier, { position: moved.position, rotation: moved.rotation })!)
    // the drag follows the source; an unchanged source sends nothing (no refill)
    const refills = part.stats().refills
    tp.update()
    part.update(e.cam, 0.016)
    expect(part.stats().refills).toBe(refills)
    const moved2 = { ...moved, scale: 1.15 }
    src = worldMatrix(moved2)
    tp.update()
    part.update(e.cam, 0.016)
    expectMatrix(e.instances()[0], speciesMatrix(moved2))
    // the end brings the merged copy back where it was
    tp.end()
    part.update(e.cam, 0.016)
    expect(part.bands.bytes[slot]).toBe(BAND_NEAR)
    expect(part.stats()).toMatchObject({ previews: 0, overlayInstances: 1, band3: 0 })
    expectMatrix(e.instances()[0], speciesMatrix(pine))
  })

  it('the drop re-merges the region with the moved tree (no frame without it); the revert restores it', async () => {
    const e = await edWorld()
    const { w, part, pine, key } = e
    const carrier = w.world.manifest.models[w.ids.pine]!
    const tp = new TreePreview(w.world)
    const moved = { ...pine, position: [pine.position[0] + 3, pine.position[1], pine.position[2] + 1] as [number, number, number] }
    expect(tp.begin(key, carrier, () => worldMatrix(moved))).toBe(true)
    part.update(e.cam, 0.016)
    // drop: the region re-batches with the moved placement (S-OBJ) while the preview still stands in for it
    const reload = w.stream.reloadObjects(CX, CZ, { placements: e.list(p => ({ ...p, position: moved.position })) })
    expect((await pumpUntil(w, reload)).value).toBe(true)
    part.update(e.cam, 0.016)
    expect(part.stats().overlayInstances).toBe(1)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_HIDDEN)
    expectMatrix(e.instances()[0], speciesMatrix(moved))
    tp.end()
    await e.until(() => part.stats().overlayInstances === 1 && part.stats().previews === 0)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_NEAR)
    expectMatrix(e.instances()[0], speciesMatrix(moved))
    // revert: the original list again; the tree is back at its exported spot
    const back = w.stream.reloadObjects(CX, CZ, { placements: e.list(p => p) })
    expect((await pumpUntil(w, back)).value).toBe(true)
    await e.until(() => part.stats().overlayInstances === 1)
    expectMatrix(e.instances()[0], speciesMatrix(pine))
    expect(part.stats()).toMatchObject({ hidden: 0, previews: 0, band3: 0 })
  })

  it('a delete holds the merged copy hidden until the re-merge without it lands; an undo brings it back', async () => {
    const e = await edWorld()
    const { w, part, key } = e
    const tp = new TreePreview(w.world)
    const used = part.slots.used
    tp.hold(key)
    part.update(e.cam, 0.016)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_HIDDEN)
    expect(part.stats()).toMatchObject({ hidden: 1, overlayInstances: 0 })
    const del = w.stream.reloadObjects(CX, CZ, { placements: e.list(() => null) })
    expect((await pumpUntil(w, del)).value).toBe(true)
    expect(part.slotOf(key)).toBeNull()
    expect(part.slots.used).toBe(used - 1)
    tp.release(key)
    part.update(e.cam, 0.016)
    expect(part.stats()).toMatchObject({ hidden: 0, overlayInstances: 0 })
    // undo: the placement comes back with a slot and draws again
    const undo = w.stream.reloadObjects(CX, CZ, { placements: e.list(p => p) })
    expect((await pumpUntil(w, undo)).value).toBe(true)
    await e.until(() => part.stats().overlayInstances === 1)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_NEAR)
    tp.dispose()
  })

  it('no trees part (Classic, retail): nothing claims, nothing previews, a hold is harmless', async () => {
    const w = await objectWorld({ render: 'classic' })
    cleanups.push(() => w.dispose())
    expect(w.world.trees).toBeNull()
    const tp = new TreePreview(w.world)
    const carrier = { treeSwap: { model: 0, fit: [1, 1, 1] as [number, number, number], tint: 0 } }
    expect(tp.claims(carrier)).toBe(false)
    expect(tp.begin(1, carrier, () => new Float32Array(16))).toBe(false)
    tp.hold(1)
    tp.release(1)
    tp.dispose()
    expect(tp.busy).toBe(false)
  })
})
