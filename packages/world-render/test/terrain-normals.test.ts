/**
 * PBR terrain normals (docs/WAVE_PLAN3.md §6.11, docs/RENDER.md §3.5 / RND-T): a flat region is straight up, a 45°
 * ramp tilts 45° the right way on both axes, the converter's baked normals are used as they are, and two neighbours
 * agree on their shared edge: with the baked normals (computed across seams at convert time), with the height
 * fallback when the neighbour is loaded, and after a neighbour commits later (TerrainRenderer re-normals the edge).
 */
import { NullEngine, Scene, VertexBuffer } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { CELLS, GRID, type TerrainBin } from '../../convert/src/world/format.ts'
import type { WorldManifest } from '../../convert/src/world/manifest.ts'
import { buildNormals } from '../../convert/src/world/terrain.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import { CLEAR_RENDER_WEATHER } from '../src/render/weather.ts'
import { WorldRegions, type RegionData } from '../src/regions.ts'
import { TerrainRenderer, terrainNormals } from '../src/terrain.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const S = Math.SQRT1_2

/** A bin with heights from `h(gx, gz)` (metres) and zero baked normals (the fallback path). */
function bin(h: (gx: number, gz: number) => number, normals?: Int8Array): Pick<TerrainBin, 'heights' | 'normals'> {
  const heights = new Float32Array(GRID * GRID)
  for (let gz = 0; gz < GRID; gz++) for (let gx = 0; gx < GRID; gx++) heights[gz * GRID + gx] = h(gx, gz)
  return { heights, normals: normals ?? new Int8Array(GRID * GRID * 4) }
}

function at(n: Float32Array, gx: number, gz: number): [number, number, number] {
  const i = (gz * GRID + gx) * 3
  return [n[i]!, n[i + 1]!, n[i + 2]!]
}

function expectVec(v: readonly number[], e: readonly number[], digits = 5): void {
  for (let k = 0; k < 3; k++) expect(v[k]).toBeCloseTo(e[k]!, digits)
}

describe('terrainNormals', () => {
  it('a flat region is (0, 1, 0) everywhere, edges included', () => {
    const { normals, computed } = terrainNormals(bin(() => 12.5))
    expect(computed).toBe(GRID * GRID)
    for (const [gx, gz] of [[0, 0], [48, 48], [96, 96], [0, 96], [96, 0]] as const) expectVec(at(normals, gx, gz), [0, 1, 0])
  })

  it('a 45° ramp rising east leans west; one rising north (file z, glTF −z) leans to +z', () => {
    const east = terrainNormals(bin(gx => 2 * gx)).normals
    for (const [gx, gz] of [[0, 10], [50, 50], [96, 3]] as const) expectVec(at(east, gx, gz), [-S, S, 0])
    const north = terrainNormals(bin((_gx, gz) => 2 * gz)).normals
    for (const [gx, gz] of [[5, 0], [50, 50], [70, 96]] as const) expectVec(at(north, gx, gz), [0, S, S])
  })

  it('uses the baked normals as they are (only zero ones fall back to the heights)', () => {
    const baked = new Int8Array(GRID * GRID * 4)
    for (let i = 0; i < GRID * GRID; i++) baked.set([0, 127, 0, 0], i * 4)
    baked.set([0, 0, 0, 0], (5 * GRID + 5) * 4) // one hole
    const { normals, computed } = terrainNormals(bin(gx => 2 * gx, baked))
    expect(computed).toBe(1)
    expectVec(at(normals, 10, 10), [0, 1, 0])
    expectVec(at(normals, 5, 5), [-S, S, 0])
  })

  // A smooth global height field over region columns x = 0, 1 and rows z = 0, 1 (global grid gx + 96 x, gz + 96 z).
  const field = (x: number, z: number) => (gx: number, gz: number) => {
    const X = gx + CELLS * x, Z = gz + CELLS * z
    return 3 * Math.sin(X * 0.07) + 2 * Math.cos(Z * 0.05) + 0.01 * X * Z
  }

  it('the height fallback agrees across an east and a north seam when the neighbour is loaded', () => {
    const bins = new Map<string, Pick<TerrainBin, 'heights' | 'normals'>>()
    for (const x of [0, 1]) for (const z of [0, 1]) bins.set(`${x},${z}`, bin(field(x, z)))
    const nb = (x: number, z: number) => (dx: number, dz: number) => bins.get(`${x + dx},${z + dz}`) ?? null
    const a = terrainNormals(bins.get('0,0')!, nb(0, 0))
    const east = terrainNormals(bins.get('1,0')!, nb(1, 0))
    const north = terrainNormals(bins.get('0,1')!, nb(0, 1))
    expect(a.edgeFallback).toBe(true) // its west and south borders have no neighbour
    for (let g = 0; g < GRID; g++) {
      expect(at(a.normals, CELLS, g)).toEqual(at(east.normals, 0, g))
      expect(at(a.normals, g, CELLS)).toEqual(at(north.normals, g, 0))
    }
  })

  it('the converter\'s baked normals agree across a seam too', () => {
    // packages/convert buildNormals over a global file-unit height field (×10: metres → file units).
    const global = (ggx: number, ggz: number) => (ggx < 0 || ggz < 0 || ggx > 2 * CELLS || ggz > CELLS ? undefined : field(0, 0)(ggx, ggz) * 10)
    const mk = (x: number) => bin((gx, gz) => field(x, 0)(gx, gz), buildNormals(x, 0, global))
    const a = terrainNormals(mk(0))
    const b = terrainNormals(mk(1))
    expect(a.computed).toBe(0)
    for (let g = 0; g < GRID; g++) expect(at(a.normals, CELLS, g)).toEqual(at(b.normals, 0, g))
  })
})

describe('TerrainRenderer PBR normals', () => {
  function world() {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => engine.dispose())
    const manifest = { space: { originRegion: { x: 100, z: 100 } }, tiles: [{ id: 1, file: 'tiles/a.png', typeName: 'Grass' }] } as unknown as WorldManifest
    const regions = new WorldRegions(manifest)
    const terrain = new TerrainRenderer(scene, regions)
    terrain.follow({ render: { mode: 'pbr', quality: RENDER_PRESETS.medium, weather: CLEAR_RENDER_WEATHER } })
    const data = (x: number): RegionData => {
      const b = bin(field(x))
      const layers = new Uint8Array(CELLS * CELLS * 4)
      for (let c = 0; c < CELLS * CELLS; c++) layers.set([1, 0, 255, 255], c * 4)
      return {
        region: { id: (100 << 8) | x, x, z: 100, origin: [192 * (x - 100), 0, 0] } as never,
        terrain: { version: 1, layerCount: 1, heights: b.heights, normals: b.normals, textures: new Uint16Array(GRID * GRID), layers },
        navmesh: null,
      }
    }
    return { terrain, regions, data }
  }
  // Curved in x, so a one-sided edge difference differs from the central one.
  const field = (x: number) => (gx: number, gz: number) => 0.002 * (gx + CELLS * (x - 100)) ** 2 + 0.001 * gz * gz

  it('builds the mesh with normals and re-normals a neighbour\'s border when the other side commits', () => {
    const { terrain, regions, data } = world()
    const a = data(100)
    regions.add(a) // streaming adds the region data before its terrain commits
    const ga = terrain.buildRegion(a, () => 0, null)
    expect(ga.mesh.isVerticesDataPresent(VertexBuffer.NormalKind)).toBe(true)
    expect(ga.mesh.isVerticesDataPresent(VertexBuffer.UVKind)).toBe(false)
    const before = Float32Array.from(ga.mesh.getVerticesData(VertexBuffer.NormalKind)!)
    const b = data(101)
    regions.add(b)
    const gb = terrain.buildRegion(b, () => 0, null)
    const na = Float32Array.from(ga.mesh.getVerticesData(VertexBuffer.NormalKind)!)
    const nbv = Float32Array.from(gb.mesh.getVerticesData(VertexBuffer.NormalKind)!)
    let changed = 0
    for (let g = 0; g < GRID; g++) {
      expect(at(na, CELLS, g)).toEqual(at(nbv, 0, g))
      if (at(before, CELLS, g)[0] !== at(na, CELLS, g)[0]) changed++
    }
    expect(changed).toBeGreaterThan(0) // the one-sided edge became a central difference
  })
})
