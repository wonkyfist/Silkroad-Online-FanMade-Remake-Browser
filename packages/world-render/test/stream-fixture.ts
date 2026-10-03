/**
 * Synthetic streamable world for the streaming tests (docs/FIELDS.md §7 lane 2): N x N flat regions with fake assets
 * served from memory (terrain bins, per-region nav chunks, nav-objects.bin), a manifest with a `stream` block, one
 * static placement per region (model 0) and one skinned placement in the centre region (model 1). Models are fake
 * containers (a box), loaded through the streamer's loadModel hook.
 */
import { AssetContainer, MeshBuilder, NullEngine, Scene, type Mesh } from '@babylonjs/core'
import { NAV_DATA_VERSION, encodeNavData, type NavRegion } from '@sro/nav'
import { CELLS, GRID, encodeTerrainBin } from '../../convert/src/world/format.ts'
import type { WorldManifest, WorldModel, WorldPlacement, WorldRegion } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  World,
  WorldRegions,
  loadNavStreamed,
  prepareStatic,
  type CachedModel,
  type NavChunkSource,
  type WorldIO,
} from '../src/index.ts'

export const N = 7
/** Region index of the south-west region; the centre region (X0 + 3, Z0 + 3) is the origin region. */
export const X0 = 100
export const Z0 = 100
export const CX = X0 + (N >> 1)
export const CZ = Z0 + (N >> 1)
/** loadWorld({ baseUrl: ROOT_URL, world: WORLD_NAME }) reads the fixture at BASE. */
export const ROOT_URL = 'http://mem.test/'
export const WORLD_NAME = 'w'
const BASE = `${ROOT_URL}world/${WORLD_NAME}/`

/** Tile id of region (x, z): three tiles in a diagonal pattern. */
export const tileOf = (x: number, z: number) => 10 + ((x + z) % 3)

function flatNavRegion(x: number, z: number, height: number): NavRegion {
  return {
    id: (z << 8) | x, rx: x, rz: z, openCellCount: 1,
    heights: new Float32Array(97 * 97).fill(height * 10),
    tileCells: new Int32Array(96 * 96),
  }
}

function terrainBin(x: number, z: number, height: number): Uint8Array {
  const n = GRID * GRID
  const layers = new Uint8Array(CELLS * CELLS * 4)
  const id = tileOf(x, z)
  for (let c = 0; c < CELLS * CELLS; c++) layers.set([id & 0xff, (id >> 8) & 3, 255, 255], c * 4)
  return encodeTerrainBin({
    layerCount: 1,
    heights: new Float32Array(n).fill(height),
    normals: new Int8Array(n * 4),
    textures: new Uint16Array(n),
    layers,
  })
}

/** Region height (m): distinct per region so heights prove which region answered. */
export const heightOf = (x: number, z: number) => (x - X0) + 10 * (z - Z0)

export interface Fixture {
  manifest: WorldManifest
  files: Map<string, Uint8Array>
  io: WorldIO
  /** URLs fetched (in order). */
  fetched: string[]
}

export function makeFixture(): Fixture {
  const regions: WorldRegion[] = []
  const placements: WorldPlacement[] = []
  const files = new Map<string, Uint8Array>()
  const put = (path: string, bytes: Uint8Array) => files.set(BASE + path, bytes)
  for (let z = Z0; z < Z0 + N; z++) {
    for (let x = X0; x < X0 + N; x++) {
      const id = (z << 8) | x
      const origin: [number, number, number] = [192 * (x - CX), 0, -192 * (z - CZ)]
      const h = heightOf(x, z)
      const file = `terrain/${x}_${z}.bin`
      put(file, terrainBin(x, z, h))
      put(`nav/${x}_${z}.bin`, encodeNavData({ version: NAV_DATA_VERSION, regions: [flatNavRegion(x, z, h)], models: [], instances: [] }))
      regions.push({
        x, z, id, origin,
        bounds: { min: [origin[0], h, origin[2] - 192], max: [origin[0] + 192, h, origin[2]] },
        terrain: { file, bytes: 0, heightMinM: h, heightMaxM: h, layerCount: 1, tileIds: [tileOf(x, z)] },
        lightmap: null,
        minimap: null,
        blocks: Array.from({ length: 36 }, (_, k) => ({ bx: k % 6, bz: Math.floor(k / 6), flag: 0, environmentId: 0, water: null })),
        navmesh: null,
      })
      placements.push(placement(id, origin[0] + 96, h, origin[2] - 96, 0, placements.length))
      if (x === CX && z === CZ) placements.push(placement(id, origin[0] + 50, h, origin[2] - 50, 1, placements.length))
    }
  }
  for (const id of [10, 11, 12]) put(`tiles/${id}.png`, new Uint8Array([id]))
  put('nav-objects.bin', encodeNavData({ version: NAV_DATA_VERSION, regions: [], models: [], instances: [] }))
  const model = (index: number, kind: 'static' | 'skinned'): WorldModel => ({
    index, source: `m${index}.bsr`, glb: `models/m${index}.glb`, sidecar: null, kind, animations: [], defaultClip: null,
    lightmappedMeshes: 0, boundsMin: [-1, 0, -1], boundsMax: [1, 2, 1], bytes: 0, validatorErrors: null,
  })
  const manifest = {
    format: 'sro-world', version: 1, name: 'synthetic', generator: 'test', createdAt: '2026-09-28T00:00:00Z',
    space: {
      units: 'metre', metresPerUnit: 0.1, handedness: 'right-handed, +Y up (glTF)',
      axes: { east: [1, 0, 0], north: [0, 0, -1], up: [0, 1, 0] },
      originRegion: { x: CX, z: CZ, id: (CZ << 8) | CX }, originCorner: 'south-west', regionSizeM: 192, cellSizeM: 2,
      regionOffsetRule: '', localToWorldRule: '',
    },
    regions,
    tiles: [10, 11, 12].map(id => ({ id, source: `t${id}.ddj`, file: `tiles/${id}.png`, width: 4, height: 4, typeName: null, category: '' })),
    water: { frames: [], frameMs: 100, ice: null, waves: [] },
    environment: { file: 'environment.json', profileIds: [] },
    models: [model(0, 'static'), model(1, 'skinned')],
    placements,
    spawn: { x: 96, y: 0, z: -96, yaw: 0, source: 'test' },
    stream: {
      playable: { x0: X0, x1: X0 + N - 1, z0: Z0, z1: Z0 + N - 1 },
      navRegions: { dir: 'nav', bytes: 0 },
      navObjects: { file: 'nav-objects.bin', bytes: 0 },
      worldMap: null,
      loadRadiusM: 400,
      unloadRadiusM: 560,
    },
    warnings: [],
    report: {},
  } as unknown as WorldManifest
  put('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
  put('environment.json', new TextEncoder().encode(JSON.stringify({ source: '', profiles: [] })))
  const fetched: string[] = []
  const io: WorldIO = {
    async bytes(url) {
      fetched.push(url)
      const b = files.get(url)
      if (!b) throw new Error(`404 ${url}`)
      return new Uint8Array(b) as Uint8Array<ArrayBuffer>
    },
    async decodeImage(_bytes, _mime, size) {
      const s = size ?? 4
      return { width: s, height: s, data: new Uint8Array(s * s * 4).fill(128) }
    },
  }
  return { manifest, files, io, fetched }
}

function placement(region: number, x: number, y: number, z: number, model: number, uid: number): WorldPlacement {
  return {
    objId: model, source: `m${model}.bsr`, models: [model], compound: false, position: [x, y, z], rotation: [0, 0, 0, 1], yaw: 0,
    flags: { static: model === 0, big: false, struct: false }, staticFlag: model === 0 ? 0xffff : 0, uid, region, group: 2,
    inConvertedRegion: true,
  }
}

export const BASE_URL = BASE

/** A NullEngine scene and a World over the fixture with the streamed nav (objects only; no streamer yet). */
export async function makeWorld(fx: Fixture): Promise<{ engine: NullEngine; scene: Scene; world: World; chunks: NavChunkSource }> {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const assets = new Assets(BASE, fx.io)
  const nav = await loadNavStreamed(fx.manifest, assets)
  const world = new World(scene, fx.manifest, { source: '', profiles: [] }, new WorldRegions(fx.manifest), nav.nav, nav.source, assets, { baseUrl: BASE, minimap: false })
  await world.water.init(assets)
  return { engine, scene, world, chunks: nav.chunks }
}

/** Fake model loads (a box container) with load/dispose counters. */
export function fakeModels(scene: Scene) {
  const loads: number[] = []
  const disposed: number[] = []
  const loadModel = async (model: WorldModel): Promise<CachedModel> => {
    loads.push(model.index)
    const container = new AssetContainer(scene)
    const box = MeshBuilder.CreateBox(`box${model.index}`, { size: 1 }, scene) as Mesh
    scene.removeMesh(box)
    container.meshes.push(box)
    return { model, container, converted: null, prep: model.kind === 'static' ? prepareStatic(container) : null }
  }
  const disposeModel = (e: CachedModel) => {
    disposed.push(e.model.index)
    e.container.dispose()
  }
  return { loads, disposed, loadModel, disposeModel }
}

/** Lets pending promises (fake fetches, decodes) settle. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0))
}
