/**
 * GL-SF test fixtures: terrain regions with native layers (format.ts layout), a tile set, and a GrassField on a
 * NullEngine scene (no assets).
 */
import { NullEngine, Scene } from '@babylonjs/core'
import { GRID } from '../../convert/src/world/format.ts'
import type { TileTexture, WorldRegion } from '../../convert/src/world/manifest.ts'
import { Assets } from '../src/assets.ts'
import { GrassField, type GrassFieldOptions } from '../src/grass/field.ts'
import type { RegionData } from '../src/regions.ts'
import type { ScatterHost } from '../src/scatter.ts'

/** Tile ids: grass, road, grassy dirt, marble (Dirt-typed pavement), GL-C's weighted tile, forest, beach sand. */
export const T = { grass: 1, road: 2, dirt: 3, marble: 4, weighted: 5, forest: 6, sand: 7 } as const

export const TILES: TileTexture[] = [
  { id: T.grass, typeName: 'Grass', source: 'c_grass_fld_03.ddj', file: 'tiles/g.webp', width: 4, height: 4, category: '' },
  { id: T.road, typeName: 'Dirt', source: 'c_road_01.ddj', file: 'tiles/r.webp', width: 4, height: 4, category: '' },
  { id: T.dirt, typeName: 'Dirt', source: 'wc_grass02_01.ddj', file: 'tiles/d.webp', width: 4, height: 4, category: '' },
  { id: T.marble, typeName: 'Dirt', source: 'c_marble_jang_08_1.ddj', file: 'tiles/m.webp', width: 4, height: 4, category: '' },
  { id: T.weighted, typeName: 'Grass', source: 'c_grass_hmfld_01.ddj', file: 'tiles/w.webp', width: 4, height: 4, category: '', grass: { weight: 0.3, base: [0.08, 0.14, 0.03], tip: [0.34, 0.44, 0.15] } },
  { id: T.forest, typeName: 'Forest', source: 'c_forest_01.ddj', file: 'tiles/f.webp', width: 4, height: 4, category: '' },
  { id: T.sand, typeName: 'Sand', source: 'asiaminor_sand_01.ddj', file: 'tiles/s.webp', width: 4, height: 4, category: '' },
]

export interface RegionSpec {
  id?: number
  /** South-west corner (glTF m). */
  ox?: number
  oz?: number
  /** Layer 0 tile everywhere. */
  base?: number
  /** Later layers: per 2 m cell (cx, cz) → [tile, mask4]. */
  layers?: Array<(cx: number, cz: number) => [number, number] | null>
  height?: (gx: number, gz: number) => number
  /** Normal y (the rest along x) per vertex. */
  normalY?: (gx: number, gz: number) => number
  /** Water plane height per block (bx, bz), or null. */
  water?: (bx: number, bz: number) => number | null
}

/** A region with the native layer planes (format.ts: (k × 96 × 96 + cz × 96 + cx) × 4 = [id lo, id hi | code << 2, mask, 255]). */
export function region(spec: RegionSpec = {}): RegionData {
  const id = spec.id ?? ((97 << 8) | 168)
  const ox = spec.ox ?? 0, oz = spec.oz ?? 0
  const n = GRID * GRID
  const heights = new Float32Array(n)
  const normals = new Int8Array(n * 4)
  for (let gz = 0; gz < GRID; gz++) {
    for (let gx = 0; gx < GRID; gx++) {
      const k = gz * GRID + gx
      heights[k] = spec.height?.(gx, gz) ?? 10
      const ny = spec.normalY?.(gx, gz) ?? 1
      normals.set([Math.round(Math.sqrt(Math.max(0, 1 - ny * ny)) * 127), Math.round(ny * 127), 0, 0], k * 4)
    }
  }
  const extra = spec.layers ?? []
  const layerCount = 1 + extra.length
  const layers = new Uint8Array(layerCount * 96 * 96 * 4)
  for (let cz = 0; cz < 96; cz++) {
    for (let cx = 0; cx < 96; cx++) {
      let k = 0
      const put = (tile: number, mask: number) => {
        const o = ((k * 96 + cz) * 96 + cx) * 4
        layers[o] = tile & 0xff
        layers[o + 1] = tile >> 8
        layers[o + 2] = mask
        layers[o + 3] = 255
        k++
      }
      put(spec.base ?? T.grass, 15)
      for (const l of extra) {
        const v = l(cx, cz)
        if (v) put(v[0], v[1])
      }
    }
  }
  const blocks = Array.from({ length: 36 }, (_, b) => {
    const bx = b % 6, bz = Math.floor(b / 6)
    const w = spec.water?.(bx, bz) ?? null
    return { bx, bz, flag: 0, environmentId: 0, water: w === null ? null : { kind: 'water', heightM: w } }
  })
  const reg = { id, x: id & 0xff, z: id >> 8, origin: [ox, 0, oz], blocks, lightmap: null } as unknown as WorldRegion
  return { region: reg, terrain: { version: 1, layerCount, heights, normals, textures: new Uint16Array(n).fill(spec.base ?? T.grass), layers } as unknown as RegionData['terrain'], navmesh: null }
}

export interface FieldRig {
  engine: NullEngine
  scene: Scene
  field: GrassField
  host: ScatterHost
  dispose(): void
}

/** A GrassField on a NullEngine scene over TILES (no lightmaps unless `opts.lightmap`). */
export function fieldRig(opts: GrassFieldOptions & { occupied?: ScatterHost['occupied']; coast?: ScatterHost['coast']; level?: 'off' | 'low' | 'medium' | 'high' } = {}): FieldRig {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const host: ScatterHost = {
    scene,
    assets: new Assets('http://mem.test/', { bytes: async () => { throw new Error('no assets') }, decodeImage: async () => ({ width: 1, height: 1, data: new Uint8Array(4) }) }),
    manifest: { tiles: TILES, models: [] },
    ...(opts.occupied ? { occupied: opts.occupied } : {}),
    ...(opts.coast ? { coast: opts.coast } : {}),
  }
  const field = new GrassField(null, host, { lightmap: null, ...opts })
  field.setLevel(opts.level ?? 'medium')
  return {
    engine, scene, field, host,
    dispose() {
      field.dispose()
      scene.dispose()
      engine.dispose()
    },
  }
}

/** The texel of a region bake at region metre (i east, j north of the south edge). */
export function texel(data: Uint8Array, i: number, j: number): [number, number, number, number] {
  const o = (j * 192 + i) * 4
  return [data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!]
}
