/**
 * Wave 12 integration (I-12, docs/WAVE_PLAN8.md §6.5), world-render's side of the cross-item tests: the trees (T12-M's
 * swap, T12-N's bands and overlay, T12-E's preview), the editor's seams (S-OBJ's region reload and editor-owned
 * placements, S-TERR's terrain update) and the terrain remaster (TT-Q's paving bit, TT-B's `texpipe hero` flip) on one
 * W12-SA object world (NullEngine):
 *
 * - a planted tree (an editor add of a species' carrier, uid 0xE000+) draws as the species on Medium (a band slot, the
 *   species merged, the retail glb never fetched), as the retail carrier on Low (Classic) and with trees 'retail';
 * - an editor height edit under a merged tree: the re-snapped placement stands at its new height, and the band byte
 *   never stays at 3 (hidden) after a cancelled drag, an undone delete or an undone re-snap;
 * - a live Low ↔ Medium switch with the trees, an editor preview and an editor-owned placement leaves no overlay mesh,
 *   band texture, preview or tree group behind, and Medium comes back with exactly one set;
 * - the batcher's draws per region are the same with the swap on as with retail trees (BT-T's fixture + the swap), and
 *   the cloth counter is unchanged after a tree group's dispose (WF8);
 * - the crowded-plaza rule (D24) from the real town part's player count: 14 players keep the LOD0 overlay to 40 m,
 *   15 pull it in to 20 m (Medium only);
 * - a painted B3c tile past 0.1 % cover: `texpipe hero` (in memory) gives its set ORMH on Medium, which the runtime's
 *   tile lookup then hands the terrain (the real index when work/out is there); the paving bit survives a paint stroke.
 *
 * The converter's side (the planted carrier's nav footprint and baked shadow, the empty edits layer, the shipped
 * content) is packages/convert/test/w12-cross.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  AssetContainer, Matrix, MeshBuilder, NullEngine, PBRMaterial, RawTexture, Scene, TransformNode, Vector3, VertexBuffer,
  type Camera, type Mesh,
} from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { TownFile } from '../../shared/src/town.ts'
import { GRID, CELLS } from '../../convert/src/world/format.ts'
import type { WorldManifest, WorldPlacement } from '../../convert/src/world/manifest.ts'
import { flipHero } from '../../texpipe/src/index-writer.ts'
import { emptyOverrides } from '../../texpipe/src/inventory.ts'
import { tileKey, type PbrIndex } from '../../texpipe/src/format.ts'
import type { SidecarLite } from '../src/materials.ts'
import { NO_ANTI_TILE } from '../src/pbr/classes.ts'
import { PbrMapIndex, mapPolicy, parsePbrIndex } from '../src/pbr/maps.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import { CLEAR_RENDER_WEATHER } from '../src/render/weather.ts'
import { WorldRegions, type RegionData } from '../src/regions.ts'
import { SKY_PRESETS } from '../src/sky/types.ts'
import { TerrainRenderer, type TerrainRenderSource } from '../src/terrain.ts'
import { stubCrowdAssets } from '../src/town/crowd.ts'
import { schedulePlan, townPartWith } from '../src/town/index.ts'
import { TreePreview } from '../src/trees/editor.ts'
import { BAND_HIDDEN, BAND_MID, BAND_NEAR, TreesNearField, placementKey, swapMatrixTo, type NearModel } from '../src/trees/index.ts'
import { WEATHER_PRESETS } from '../src/weather/presets.ts'
import { settle } from './stream-fixture.ts'
import { CX, CZ, isTreeMesh, objectWorld, pumpUntil, type ObjectWorld, type ObjectWorldOptions } from './w12-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const REPO = new URL('../../../', import.meta.url)
const CENTRE_ID = (CZ << 8) | CX
/** The editor's first uid of a region (S-UID: 0xE000–0xEFFF). */
const EDITOR_UID = 0xe000
const FIT: [number, number, number] = [1.1, 0.9, 1.1]

/** A minimal LOD0 (a bark box and a leaf card) for the overlay. */
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

interface CrossWorld {
  w: ObjectWorld
  /** Every trees part the world made (a render switch makes a new one). */
  parts: TreesNearField[]
  species: number
  pine: WorldPlacement
  /** The editor's add (a planted pine carrier) in the centre region, or null. */
  planted: WorldPlacement | null
  cam(at: readonly number[], dx?: number): Camera
  /** Updates the live part until `done` (pumping promises). */
  until(cam: Camera, done: () => boolean): Promise<void>
  /** The centre region's own placements with `edit` applied to the centre pine (null: deleted). */
  list(edit: (p: WorldPlacement) => WorldPlacement | null): WorldPlacement[]
}

/** The object world with the pine swapped to a pine07 species, T12-N's part (a test LOD0) and options. */
async function crossWorld(o: Partial<ObjectWorldOptions> & { plant?: boolean } = {}): Promise<CrossWorld> {
  let species = -1
  const parts: TreesNearField[] = []
  const w = await objectWorld({
    ...o,
    edit: (fx, ids) => {
      const models = fx.manifest.models
      species = models.length
      models.push({
        ...models[ids.pine]!, index: species, source: 'res\\nature\\common\\tree\\w12\\pine07.bsr#species', glb: 'models/trees/pine07/far.glb',
        sidecar: null, boundsMin: [-1, 0, -1], boundsMax: [1, 6, 1],
      })
      models[ids.pine]!.treeSwap = { model: species, fit: FIT, tint: 0 }
      if (o.plant) {
        const pine = fx.manifest.placements.find(p => p.models[0] === ids.pine && p.region === CENTRE_ID)!
        // the editor's add: a fresh editor uid, the carrier's source and model, a planted scale (D17: 0.85–1.15)
        fx.manifest.placements.push({ ...pine, uid: EDITOR_UID, position: [pine.position[0] + 6, pine.position[1], pine.position[2] + 4], scale: 1.1 })
      }
      o.edit?.(fx, ids)
    },
    parts: {
      ...o.parts,
      trees: host => {
        const part = new TreesNearField(host, {
          load: async () => {
            await settle(1)
            return nearContainer(host.scene)
          },
          kindOf: async () => 'tree',
        })
        parts.push(part)
        return part
      },
    },
  })
  cleanups.push(() => w.dispose())
  await w.run()
  const pine = w.fx.manifest.placements.find(p => p.models[0] === w.ids.pine && p.region === CENTRE_ID && p.uid !== EDITOR_UID)!
  const planted = w.fx.manifest.placements.find(p => p.region === CENTRE_ID && p.uid === EDITOR_UID) ?? null
  const live = () => w.world.trees as TreesNearField | null
  const cw: CrossWorld = {
    w, parts, species, pine, planted,
    cam: (at, dx = 3) => ({ globalPosition: new Vector3(at[0]! + dx, at[1]! + 2, at[2]!) }) as unknown as Camera,
    async until(cam, done) {
      for (let i = 0; i < 80; i++) {
        live()?.update(cam, 0.016)
        if (done()) return
        await settle(2)
      }
      throw new Error(`trees part did not settle: ${JSON.stringify(live()?.stats())}`)
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
  return cw
}

/** The species matrix of a placement as the merge folds it (fit, no offset). */
const speciesMatrix = (p: Pick<WorldPlacement, 'position' | 'rotation' | 'scale'>) => {
  const m = new Float32Array(16)
  swapMatrixTo(p, FIT, null, m, 0, new Matrix())
  return m
}

/** The overlay's instance matrices of the first overlay mesh (16 floats each). */
function instances(part: TreesNearField): Float32Array[] {
  const m = part.meshes()[0] as Mesh | undefined
  if (!m || !m.isVisible) return []
  const data = (m as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array | null } })._thinInstanceDataStorage.matrixData
  const out: Float32Array[] = []
  for (let k = 0; k < m.thinInstanceCount; k++) out.push(data!.slice(k * 16, k * 16 + 16))
  return out
}

const near = (a: ArrayLike<number> | undefined, b: ArrayLike<number>) => {
  expect(a).toBeDefined()
  for (let i = 0; i < 16; i++) expect(a![i]).toBeCloseTo(b[i]!, 4)
}

describe('I-12: a planted tree (an editor add of a species carrier, D16)', () => {
  it('Medium: the species (a band slot, merged, an overlay instance); the retail carrier glb is never fetched', async () => {
    const cw = await crossWorld({ plant: true })
    const part = cw.w.world.trees as TreesNearField
    expect(part).toBe(cw.parts[0])
    const key = placementKey(CENTRE_ID, EDITOR_UID)
    expect(part.slotOf(key)).not.toBeNull()
    expect(cw.w.loads).toContain(cw.species)
    expect(cw.w.loads).not.toContain(cw.w.ids.pine)
    // standing between the exported pine and the planted one: both draw as the species' LOD0 (band 0)
    const cam = cw.cam(cw.pine.position, 3)
    await cw.until(cam, () => part.stats().overlayInstances === 2)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_NEAR)
    const got = instances(part)
    expect(got).toHaveLength(2)
    const want = speciesMatrix(cw.planted!)
    near(got.find(m => Math.abs(m[12]! - want[12]!) < 1e-3 && Math.abs(m[14]! - want[14]!) < 1e-3), want)
  })

  for (const variant of ['classic', 'retail'] as const) {
    it(`${variant === 'classic' ? 'Low (Classic)' : "trees 'retail'"}: the retail carrier; no trees part, no species fetched`, async () => {
      const cw = await crossWorld({ plant: true, ...(variant === 'classic' ? { render: 'classic' as const } : { trees: 'retail' as const }) })
      expect(cw.w.world.trees).toBeNull()
      expect(cw.parts).toHaveLength(0)
      expect(cw.w.loads).toContain(cw.w.ids.pine)
      expect(cw.w.loads).not.toContain(cw.species)
      // the planted carrier is placed like any retail tree (Classic: a chunk instance; 'retail': the merged retail group)
      const placed = cw.w.world.objects.stats
      expect(placed.thinInstances + (cw.w.parts[0]?.stats.mergedPlacements ?? 0) + placed.clones).toBeGreaterThan(0)
    })
  }
})

describe('I-12: an editor height edit under a merged tree (D21)', () => {
  it('the re-snapped tree stands at its new height; a cancelled drag, an undone delete and an undone re-snap never leave band 3', async () => {
    const cw = await crossWorld()
    const { w, pine } = cw
    const part = w.world.trees as TreesNearField
    const key = placementKey(pine.region, pine.uid)
    const cam = cw.cam(pine.position)
    await cw.until(cam, () => part.stats().overlayInstances === 1)
    // the edits pass re-snaps the tree on the raised ground (+2 m, clearance kept): the region re-batches (S-OBJ)
    const raised = { ...pine, position: [pine.position[0], pine.position[1] + 2, pine.position[2]] as [number, number, number] }
    expect((await pumpUntil(w, w.stream.reloadObjects(CX, CZ, { placements: cw.list(() => raised) }))).value).toBe(true)
    await cw.until(cam, () => part.stats().overlayInstances === 1 && Math.abs(instances(part)[0]![13]! - speciesMatrix(raised)[13]!) < 1e-4)
    near(instances(part)[0], speciesMatrix(raised))
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_NEAR)
    // a drag cancelled (no drop): the merged copy comes back
    const tp = new TreePreview(w.world)
    const carrier = w.world.manifest.models[w.ids.pine]!
    expect(tp.begin(key, carrier, () => speciesMatrix(pine))).toBe(true)
    part.update(cam, 0.016)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_HIDDEN)
    tp.end()
    part.update(cam, 0.016)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_NEAR)
    // a delete undone before its re-merge landed
    tp.hold(key)
    part.update(cam, 0.016)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_HIDDEN)
    tp.release(key)
    part.update(cam, 0.016)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_NEAR)
    // the re-snap undone: the exported list again, the tree back at its height
    expect((await pumpUntil(w, w.stream.reloadObjects(CX, CZ, { placements: cw.list(p => p) }))).value).toBe(true)
    await cw.until(cam, () => part.stats().overlayInstances === 1 && Math.abs(instances(part)[0]![13]! - speciesMatrix(pine)[13]!) < 1e-4)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_NEAR)
    expect(part.stats()).toMatchObject({ hidden: 0, previews: 0, band3: 0 })
    tp.dispose()
  })
})

describe('I-12: a live Low ↔ Medium switch with all three items', () => {
  it('leaves no overlay mesh, band texture, preview or tree group; Medium comes back with exactly one set', async () => {
    const cw = await crossWorld({ plant: true })
    const { w, pine } = cw
    const scene = w.scene
    const first = w.world.trees as TreesNearField
    const cam = cw.cam(pine.position)
    await cw.until(cam, () => first.stats().overlayInstances === 2)
    // the editor: the planted tree editor-owned (S-OBJ) and a drag preview of the exported pine (T12-E)
    w.world.objects.setEditorOwned(p => p.region === CENTRE_ID && p.uid === EDITOR_UID)
    expect((await pumpUntil(w, w.stream.reloadObjects(CX, CZ))).value).toBe(true)
    const tp = new TreePreview(w.world)
    expect(tp.begin(placementKey(pine.region, pine.uid), w.world.manifest.models[w.ids.pine]!, () => speciesMatrix(pine))).toBe(true)
    first.update(cam, 0.016)
    expect(first.stats().previews).toBe(1)
    const overlay0 = first.meshes()
    const band0 = first.bandTexture
    expect(overlay0.length).toBeGreaterThan(0)
    expect(band0).not.toBeNull()
    const bandName = band0!.name
    // → Low (Classic)
    w.world.setRenderMode('classic')
    await w.run()
    expect(w.world.trees).toBeNull()
    expect(first.isDisposed).toBe(true)
    for (const m of overlay0) expect(m.isDisposed()).toBe(true)
    expect(scene.meshes.filter(m => /^trees:near:/.test(m.name))).toEqual([])
    expect(scene.meshes.filter(m => isTreeMesh(m) && !m.isDisposed())).toEqual([])
    expect(scene.textures.includes(band0!)).toBe(false)
    expect(scene.textures.filter(t => t.name === bandName)).toEqual([])
    // the editor's drag ends on its own (drop or cancel): harmless on a disposed part, and nothing was left to hide
    tp.end()
    expect(tp.busy).toBe(false)
    // → Medium again: one new part, one overlay set, one band texture; the editor's ownership still holds
    w.world.setRenderMode('pbr')
    await w.run()
    const second = w.world.trees as TreesNearField
    expect(second).not.toBe(first)
    expect(cw.parts).toHaveLength(2)
    await cw.until(cam, () => second.stats().overlayInstances === 1)
    expect(second.slotOf(placementKey(CENTRE_ID, EDITOR_UID))).toBeNull()
    const live = scene.meshes.filter(m => /^trees:near:/.test(m.name) && !m.isDisposed())
    expect(live.length).toBe(second.meshes().length)
    expect(scene.textures.filter(t => t.name === bandName).length).toBeLessThanOrEqual(1)
    w.world.objects.setEditorOwned(null)
    tp.dispose()
  })
})

describe('I-12: the batcher with the swap (BT-T fixture + the swap, WF8)', () => {
  const drawsPerRegion = (w: ObjectWorld) => {
    const out = new Map<number, number>()
    for (const b of w.world.objects.regionBatches.values()) out.set(b.region, (b.meshes as unknown[]).length)
    return out
  }

  it('draws per region are the same with the swap on as with retail trees', async () => {
    const retail = await crossWorld({ trees: 'retail' })
    const swapped = await crossWorld()
    const a = drawsPerRegion(retail.w)
    const b = drawsPerRegion(swapped.w)
    expect(a.size).toBeGreaterThan(0)
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort())
  })

  it('the cloth counter is unchanged after a tree group\'s dispose (a region re-batched twice)', async () => {
    const cw = await crossWorld()
    const part = cw.w.parts.at(-1)!
    const cloth0 = part.stats.clothGroups
    for (let k = 0; k < 2; k++) expect((await pumpUntil(cw.w, cw.w.stream.reloadObjects(CX, CZ))).value).toBe(true)
    expect(part.stats.clothGroups).toBe(cloth0)
  })
})

describe('I-12: the crowded-plaza rule from the town part\'s player count (D24)', () => {
  it('14 players: the overlay to 40 m; 15 (the game\'s town feature count on TownLife): to 20 m; never off Medium', async () => {
    const jangan = JSON.parse(readFileSync(new URL('content/town/jangan.json', REPO), 'utf8')) as TownFile
    const cw = await crossWorld({
      parts: { town: townPartWith({ plan: (w, noFolk) => schedulePlan(jangan, w, noFolk), assets: (s, d) => stubCrowdAssets(s, d) }) },
    })
    const { w, pine } = cw
    const part = w.world.trees as TreesNearField
    const town = w.world.town as unknown as { setPlayers(n: number): void; stats(): Readonly<Record<string, number>> }
    expect(typeof town.setPlayers).toBe('function')
    const key = placementKey(pine.region, pine.uid)
    // 28 m from the tree (its bounding radius ≈ 3.3 m): inside 40 m, outside 20 m + the 3 m hysteresis
    const cam = cw.cam(pine.position, 28)
    town.setPlayers(14)
    await cw.until(cam, () => part.stats().overlayInstances === 1)
    // the trees part polls the town's count (PLAYER_POLL_S)
    for (let i = 0; i < 4; i++) part.update(cam, 1)
    expect(part.crowded).toBe(false)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_NEAR)
    town.setPlayers(15)
    expect(town.stats().players).toBe(15)
    for (let i = 0; i < 4; i++) part.update(cam, 1)
    expect(part.crowded).toBe(true)
    expect(part.bands.bytes[part.slotOf(key)!]).toBe(BAND_MID)
    expect(part.stats().overlayInstances).toBe(0)
    // High: never crowded
    w.world.setQuality('high')
    for (let i = 0; i < 4; i++) part.update(cam, 1)
    expect(part.crowded).toBe(false)
  })
})

describe('I-12: a painted tile and the terrain remaster', () => {
  it('a painted B3c tile past 0.1 % cover: `texpipe hero` gives its set ORMH on Medium (the real index when present)', () => {
    const file = new URL('work/out/pbr/index.json', REPO)
    let index: PbrIndex
    let key: string
    if (existsSync(file)) {
      index = JSON.parse(readFileSync(file, 'utf8')) as PbrIndex
      // a B3c tile: a terrain set that is not hero (its maps are encoded, D7: every B3 set carries all maps)
      const k = Object.keys(index.sets).find(s => s.startsWith('tile2d:') && !index.sets[s]!.hero &&
        Object.values(index.sets[s]!.tiers).some(t => t.ao || t.nx))
      expect(k, 'a non-hero B3c set with maps').toBeDefined()
      key = k!
    } else {
      return
    }
    // the runtime's own lookup (stream.ts tileSetup: `index.tile(stem, policy)`) on Medium's policy, before and after
    const policy = mapPolicy('medium')
    const stem = key.slice('tile2d:'.length)
    expect(tileKey(`${stem}.ddj`)).toBe(key)
    const before = new PbrMapIndex({ pbr: parsePbrIndex(index, 'http://x/pbr/index.json') }).tile(stem, policy)!
    expect(before).not.toBeNull()
    expect(before.ormh).toBeNull()
    const r = flipHero(emptyOverrides(), index, key, true)
    expect(r.changed.index).toBe(true)
    const after = new PbrMapIndex({ pbr: parsePbrIndex(r.index, 'http://x/pbr/index.json') }).tile(stem, policy)!
    expect(after.ormh).not.toBeNull()
    expect(after.albedo(512)).toBeTruthy()
  })

  it('the paving bit (no anti-tiling, 64) survives a paint stroke beside it; the painted cells take their own bit', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    cleanups.push(() => engine.dispose())
    // tile 1 grass, tile 2 dirt, tile 3 the plaza paving (c_marble: TT-Q's no-anti-tile name rule)
    const manifest = {
      space: { originRegion: { x: 100, z: 100 } },
      tiles: [
        { id: 1, file: 'tiles/c_grass_fld_03.png', typeName: 'Grass' },
        { id: 2, file: 'tiles/c_dust_fld_01.png', typeName: 'Dirt' },
        { id: 3, file: 'tiles/c_marble_jang_01.png', typeName: 'Stone' },
      ],
    } as unknown as WorldManifest
    const regions = new WorldRegions(manifest)
    const terrain = new TerrainRenderer(scene, regions)
    terrain.follow({
      render: { mode: 'pbr', quality: RENDER_PRESETS.medium, weather: CLEAR_RENDER_WEATHER },
      sky: { quality: SKY_PRESETS.medium, state: { exposure: 8 } },
      weather: { preset: WEATHER_PRESETS.medium },
    } as unknown as TerrainRenderSource)
    // the west half paving, the east half grass; one layer per cell
    const words = new Uint16Array(GRID * GRID)
    for (let gz = 0; gz < GRID; gz++) for (let gx = 0; gx < GRID; gx++) words[gz * GRID + gx] = (gx < 48 ? 3 : 1) | (1 << 13)
    const layers = new Uint8Array(CELLS * CELLS * 4)
    for (let cz = 0; cz < CELLS; cz++) for (let cx = 0; cx < CELLS; cx++) {
      const o = (cz * CELLS + cx) * 4
      layers[o] = cx < 48 ? 3 : 1
      layers[o + 1] = 1 << 2
      layers[o + 2] = 15
      layers[o + 3] = 255
    }
    const d: RegionData = {
      region: { id: (100 << 8) | 100, x: 100, z: 100, origin: [0, 0, 0] } as never,
      terrain: { version: 1, layerCount: 1, heights: new Float32Array(GRID * GRID), normals: new Int8Array(GRID * GRID * 4), textures: words, layers },
      navmesh: null,
    }
    regions.add(d)
    const g = terrain.buildRegion(d, id => id - 1, null)
    const map0 = g.layerMap
    let uploads = 0
    const update0 = (map0 as RawTexture).update.bind(map0)
    ;(map0 as RawTexture).update = (data: ArrayBufferView) => {
      uploads++
      update0(data)
    }
    // paint dirt on a patch of the grass half (the editor's stroke: words only)
    const w = Uint16Array.from(words)
    for (let gz = 40; gz <= 44; gz++) for (let gx = 60; gx <= 64; gx++) w[gz * GRID + gx] = 2 | (1 << 13)
    expect(terrain.updateRegion(d.region.id, { words: w })!.words).toBeGreaterThan(0)
    // the layer map went to the GPU again (in place, or a deeper map when a cell gained a layer)
    expect(uploads > 0 || g.layerMap !== map0).toBe(true)
    // its texels: the region build's own layerData (D5: one function for the build and the update)
    const t = terrain as unknown as { layerData(d: RegionData, layerOf: (id: number) => number | undefined): Uint8Array; layerOfRegion: Map<number, (id: number) => number | undefined> }
    const bytes = t.layerData(d, t.layerOfRegion.get(d.region.id)!)
    const alphaOf = (cx: number, cz: number, k = 0) => bytes[(k * CELLS * CELLS + cz * CELLS + cx) * 4 + 3]!
    // paving cells keep the bit; grass and the painted dirt cells do not have it
    for (const [cx, cz] of [[5, 5], [20, 60], [47, 40]] as const) expect(alphaOf(cx, cz) & NO_ANTI_TILE).toBe(NO_ANTI_TILE)
    for (const [cx, cz] of [[70, 70], [62, 42]] as const) expect(alphaOf(cx, cz) & NO_ANTI_TILE).toBe(0)
    for (const [cx, cz] of [[5, 5], [70, 70]] as const) expect(alphaOf(cx, cz)).toBeGreaterThanOrEqual(128)
  })
})
