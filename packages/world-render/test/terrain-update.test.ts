/**
 * W12-SB, seam S-TERR (docs/WAVE_PLAN8.md §4.3, D5; docs/WORLD_EDITOR.md §5.2): `TerrainRenderer.updateRegion` and the
 * edit maths of terrain-edit.ts, headless on both material paths.
 *
 * - a region updated with its own heights and words is bit-identical (no upload, no new texture);
 * - an update's seam vertices equal the neighbour's (positions and normals), whatever order the two regions update in;
 * - painted words re-layer exactly as the converter's native layering (`blockLayers`), only in the touched blocks, and
 *   the layer map is re-uploaded through the region build's own `layerData` (a new texture when the count grows);
 * - the port equals the converter's layering on every region of the export (when it is on disk).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { NullEngine, RawTexture, Scene, ShaderMaterial, VertexBuffer, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { CELLS, GRID, decodeTerrainBin } from '../../convert/src/world/format.ts'
import type { WorldManifest } from '../../convert/src/world/manifest.ts'
import { blockLayers } from '../../convert/src/world/terrain.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import { CLEAR_RENDER_WEATHER } from '../src/render/weather.ts'
import { WorldRegions, type RegionData } from '../src/regions.ts'
import { SKY_PRESETS } from '../src/sky/types.ts'
import { TerrainRenderer, type TerrainRenderSource } from '../src/terrain.ts'
import { blockLayersOf, relayer, renormalRing } from '../src/terrain-edit.ts'
import { WEATHER_PRESETS } from '../src/weather/presets.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** Region words: tile `base` (tiling code 1) everywhere, `paint(gx, gz)` where it says. */
function words(base: number, paint?: (gx: number, gz: number) => number | null): Uint16Array {
  const w = new Uint16Array(GRID * GRID)
  for (let gz = 0; gz < GRID; gz++) {
    for (let gx = 0; gx < GRID; gx++) w[gz * GRID + gx] = paint?.(gx, gz) ?? (base | (1 << 13))
  }
  return w
}

/** The converter's layering of a whole region (its `buildLayers`, fed the 97 × 97 words as 36 blocks of 17 × 17). */
function convertLayers(w: Uint16Array): { layers: Uint8Array; layerCount: number } {
  const per: Array<Array<[number, number]>> = new Array(CELLS * CELLS)
  for (let bz = 0; bz < 6; bz++) {
    for (let bx = 0; bx < 6; bx++) {
      const b = new Uint16Array(17 * 17)
      for (let z = 0; z < 17; z++) for (let x = 0; x < 17; x++) b[z * 17 + x] = w[(bz * 16 + z) * GRID + bx * 16 + x]!
      const cells = blockLayers(b)
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) per[(bz * 16 + z) * CELLS + bx * 16 + x] = cells[z * 16 + x]!
    }
  }
  let layerCount = 1
  for (const l of per) layerCount = Math.max(layerCount, Math.min(8, l.length))
  const layers = new Uint8Array(layerCount * CELLS * CELLS * 4)
  per.forEach((l0, c) => {
    const l = l0.length > 8 ? l0.slice(l0.length - 8) : l0
    l.forEach(([key, mask], k) => {
      const o = (k * CELLS * CELLS + c) * 4
      layers[o] = (key >>> 3) & 0xff
      layers[o + 1] = (key >>> 11) | ((key & 7) << 2)
      layers[o + 2] = k === 0 ? 15 : mask
      layers[o + 3] = 255
    })
  })
  return { layers, layerCount }
}

function setup(mode: 'classic' | 'pbr') {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  cleanups.push(() => engine.dispose())
  const manifest = {
    space: { originRegion: { x: 100, z: 100 } },
    tiles: [1, 2, 3].map(id => ({ id, file: `tiles/t${id}.png`, typeName: 'Grass' })),
  } as unknown as WorldManifest
  const regions = new WorldRegions(manifest)
  const terrain = new TerrainRenderer(scene, regions)
  if (mode === 'pbr') {
    terrain.follow({
      render: { mode: 'pbr', quality: RENDER_PRESETS.medium, weather: CLEAR_RENDER_WEATHER },
      sky: { quality: SKY_PRESETS.medium, state: { exposure: 8 } },
      weather: { preset: WEATHER_PRESETS.medium },
    } as unknown as TerrainRenderSource)
  }
  /** Region (x, z) with smooth hills (continuous across seams) and the converter's layers of its words. */
  const data = (x: number, z = 100, w = words(1, (gx, gz) => (gx + gz) % 37 < 6 ? 2 | (1 << 13) : null)): RegionData => {
    const heights = new Float32Array(GRID * GRID)
    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 0; gx < GRID; gx++) {
        const X = (x - 100) * CELLS + gx, Z = (z - 100) * CELLS + gz
        heights[gz * GRID + gx] = 5 * Math.sin(X * 0.07) + 3 * Math.cos(Z * 0.05)
      }
    }
    const { layers, layerCount } = convertLayers(w)
    const d: RegionData = {
      region: { id: (z << 8) | x, x, z, origin: [192 * (x - 100), 0, 192 * (100 - z)] } as never,
      terrain: { version: 1, layerCount, heights, normals: new Int8Array(GRID * GRID * 4), textures: Uint16Array.from(w), layers },
      navmesh: null,
    }
    regions.add(d)
    return d
  }
  return { scene, terrain, regions, data }
}

const vb = (m: Mesh, kind: string) => Float32Array.from(m.getVerticesData(kind) as ArrayLike<number>)

describe('updateRegion: identity', () => {
  for (const mode of ['classic', 'pbr'] as const) {
    it(`${mode}: the region's own heights and words change nothing (bit-identical, no upload)`, () => {
      const { terrain, data } = setup(mode)
      const d = data(100)
      const g = terrain.buildRegion(d, id => id - 1, null)
      const pos0 = vb(g.mesh, VertexBuffer.PositionKind)
      const nor0 = mode === 'pbr' ? vb(g.mesh, VertexBuffer.NormalKind) : null
      const layers0 = Uint8Array.from(d.terrain.layers)
      const map0 = g.layerMap
      const heights0 = Float32Array.from(d.terrain.heights)
      let events = 0
      terrain.onRegionUpdated.add(() => events++)
      const r = terrain.updateRegion(d.region.id, { heights: Float32Array.from(d.terrain.heights), words: Uint16Array.from(d.terrain.textures) })!
      expect(r).toMatchObject({ heights: 0, words: 0, blocks: 0, resized: false, neighbours: [], lightmap: false })
      expect(events).toBe(0)
      expect(g.mesh.isVertexBufferUpdatable(VertexBuffer.PositionKind)).toBe(false)
      expect(vb(g.mesh, VertexBuffer.PositionKind)).toEqual(pos0)
      if (nor0) expect(vb(g.mesh, VertexBuffer.NormalKind)).toEqual(nor0)
      expect(d.terrain.heights).toEqual(heights0)
      expect(d.terrain.layers).toEqual(layers0)
      expect(g.layerMap).toBe(map0)
    })
  }

  it('an unloaded region answers null', () => {
    const { terrain } = setup('pbr')
    expect(terrain.updateRegion(12345, { heights: new Float32Array(GRID * GRID) })).toBeNull()
  })
})

describe('updateRegion: heights', () => {
  it('re-uploads positions and the bounding box; a later edit updates the buffer in place', () => {
    const { terrain, data } = setup('classic')
    const d = data(100)
    const g = terrain.buildRegion(d, id => id - 1, null)
    const h = Float32Array.from(d.terrain.heights)
    h[48 * GRID + 48] = 40
    const r = terrain.updateRegion(d.region.id, { heights: h })!
    expect(r.heights).toBe(1)
    expect(vb(g.mesh, VertexBuffer.PositionKind)[(48 * GRID + 48) * 3 + 1]).toBe(40)
    expect(g.mesh.getBoundingInfo().boundingBox.maximum.y).toBeCloseTo(40, 5)
    expect(g.mesh.isVertexBufferUpdatable(VertexBuffer.PositionKind)).toBe(true)
    // in place, bounded by rect
    d.terrain.heights[10 * GRID + 10] = -20
    const r2 = terrain.updateRegion(d.region.id, { heights: d.terrain.heights }, { x0: 10, z0: 10, x1: 10, z1: 10 })!
    expect(r2.heights).toBe(1)
    expect(vb(g.mesh, VertexBuffer.PositionKind)[(10 * GRID + 10) * 3 + 1]).toBe(-20)
    expect(g.mesh.getBoundingInfo().boundingBox.minimum.y).toBeCloseTo(-20, 5)
  })

  it('re-bakes the normals of the one-vertex ring only (and names the seam copies in the neighbours)', () => {
    const t = { heights: new Float32Array(GRID * GRID), normals: new Int8Array(GRID * GRID * 4).fill(9) }
    t.heights[50 * GRID + 50] = 4
    const out = renormalRing(t, [50 * GRID + 50], () => null)
    const rebaked = [...Array(GRID * GRID).keys()].filter(i => t.normals[i * 4 + 3] === 0)
    expect(rebaked.sort((a, b) => a - b)).toEqual([49, 50, 51].flatMap(z => [49, 50, 51].map(x => z * GRID + x)))
    expect(out).toEqual([])
    // the centre is a peak: flat normal; its east neighbour leans east (+x), its north neighbour north (glTF -z)
    expect([...t.normals.subarray((50 * GRID + 50) * 4, (50 * GRID + 50) * 4 + 4)]).toEqual([0, 127, 0, 0])
    expect(t.normals[(50 * GRID + 51) * 4]).toBeGreaterThan(0)
    expect(t.normals[(51 * GRID + 50) * 4 + 2]).toBeLessThan(0)
    // a vertex next to the east seam: its ring reaches the seam line (x 96) and the east neighbour holds it at x 0
    const seam = renormalRing(t, [20 * GRID + 95], () => null)
    expect(seam).toEqual(expect.arrayContaining([[1, 0, 19 * GRID + 0], [1, 0, 20 * GRID + 0], [1, 0, 21 * GRID + 0]]))
    expect(seam.every(([dx, dz]) => dx === 1 && dz === 0)).toBe(true)
  })

  for (const order of ['east first', 'west first'] as const) {
    it(`PBR: a seam edit leaves both sides with equal positions and normals (${order})`, () => {
      const { terrain, data } = setup('pbr')
      const w = data(100), e = data(101)
      const gw = terrain.buildRegion(w, id => id - 1, null)
      const ge = terrain.buildRegion(e, id => id - 1, null)
      // a raise stamp centred on the shared seam (west x 96 = east x 0), rows 30..40, reaching 3 vertices each side
      const hw = Float32Array.from(w.terrain.heights), he = Float32Array.from(e.terrain.heights)
      for (let gz = 30; gz <= 40; gz++) {
        for (let k = -3; k <= 3; k++) {
          const dh = 2 * (1 - Math.abs(k) / 4)
          if (k <= 0) hw[gz * GRID + 96 + k] = w.terrain.heights[gz * GRID + 96 + k]! + dh
          if (k >= 0) he[gz * GRID + k] = e.terrain.heights[gz * GRID + k]! + dh
        }
      }
      const steps = [() => terrain.updateRegion(w.region.id, { heights: hw }), () => terrain.updateRegion(e.region.id, { heights: he })]
      if (order === 'east first') steps.reverse()
      const results = steps.map(s => s()!)
      expect(results.every(r => r.heights === 11 * 4)).toBe(true)
      expect(results[0]!.neighbours.length).toBeGreaterThan(0)
      const pw = vb(gw.mesh, VertexBuffer.PositionKind), pe = vb(ge.mesh, VertexBuffer.PositionKind)
      const nw = vb(gw.mesh, VertexBuffer.NormalKind), ne = vb(ge.mesh, VertexBuffer.NormalKind)
      let raised = 0
      for (let gz = 0; gz < GRID; gz++) {
        const iw = gz * GRID + 96, ie = gz * GRID
        expect(pw[iw * 3 + 1]).toBe(pe[ie * 3 + 1])
        expect([nw[iw * 3], nw[iw * 3 + 1], nw[iw * 3 + 2]]).toEqual([ne[ie * 3], ne[ie * 3 + 1], ne[ie * 3 + 2]])
        if (gz >= 30 && gz <= 40) raised++
      }
      expect(raised).toBe(11)
      // the raised seam really tilts the normals next to it
      expect(nw[(35 * GRID + 94) * 3]).toBeLessThan(0)
    })
  }

  it('the upload stays within the S-TERR budget (≤ 1 ms per region on the dev PC; a 10 ms median guard headless)', () => {
    const { terrain, data } = setup('pbr')
    const d = data(100)
    terrain.buildRegion(d, id => id - 1, null)
    const h = Float32Array.from(d.terrain.heights)
    const ms: number[] = []
    for (let k = 0; k < 21; k++) {
      for (let i = 0; i < 400; i++) h[(30 + (i % 20)) * GRID + 30 + ((i / 20) | 0)] = h[(30 + (i % 20)) * GRID + 30 + ((i / 20) | 0)]! + 0.01
      ms.push(terrain.updateRegion(d.region.id, { heights: h }, { x0: 30, z0: 30, x1: 49, z1: 49 })!.ms)
    }
    ms.sort((a, b) => a - b)
    expect(ms[10]).toBeLessThan(10)
  })
})

describe('updateRegion: words (texture paint)', () => {
  for (const mode of ['classic', 'pbr'] as const) {
    it(`${mode}: re-layers like the converter, in the touched blocks only, and re-uploads the layer map in place`, () => {
      const { terrain, data } = setup(mode)
      const d = data(100)
      const g = terrain.buildRegion(d, id => id - 1, null)
      const map0 = g.layerMap
      const before = Uint8Array.from(d.terrain.layers)
      const count0 = d.terrain.layerCount
      // paint tile 2 (code 1) over a 3 × 3 vertex patch inside block (2, 2): no new layer in any cell
      const w = Uint16Array.from(d.terrain.textures)
      for (let gz = 40; gz <= 42; gz++) for (let gx = 40; gx <= 42; gx++) w[gz * GRID + gx] = 2 | (1 << 13)
      const r = terrain.updateRegion(d.region.id, { words: w })!
      expect(r.words).toBeGreaterThan(0)
      expect(r.blocks).toBe(1)
      const want = convertLayers(w)
      expect(d.terrain.layerCount).toBe(want.layerCount)
      expect(d.terrain.layers).toEqual(want.layers)
      expect(d.terrain.textures).toEqual(w)
      if (want.layerCount === count0) expect(g.layerMap).toBe(map0)
      // cells outside block (2, 2) kept their bytes
      const plane = CELLS * CELLS * 4
      for (let cz = 0; cz < CELLS; cz += 7) {
        for (let cx = 0; cx < CELLS; cx += 5) {
          if ((cx >> 4) === 2 && (cz >> 4) === 2) continue
          const o = (cz * CELLS + cx) * 4
          expect([...d.terrain.layers.subarray(o, o + 4)]).toEqual([...before.subarray(o, o + 4)])
          if (count0 > 1) expect([...d.terrain.layers.subarray(plane + o, plane + o + 4)]).toEqual([...before.subarray(plane + o, plane + o + 4)])
        }
      }
    })

    it(`${mode}: a paint that adds a layer makes a deeper layer map and binds it`, () => {
      const { terrain, data } = setup(mode)
      const d = data(100, 100, words(1))
      const g = terrain.buildRegion(d, id => id - 1, null)
      expect(d.terrain.layerCount).toBe(1)
      const map0 = g.layerMap
      let disposed = false
      map0.onDisposeObservable.add(() => (disposed = true))
      const w = Uint16Array.from(d.terrain.textures)
      // a block edge vertex (x 16) of tile 2 and one of tile 3 beside it: two blocks, three layers in a cell
      w[20 * GRID + 16] = 2 | (1 << 13)
      w[20 * GRID + 17] = 3 | (1 << 13)
      const r = terrain.updateRegion(d.region.id, { words: w }, { x0: 10, z0: 10, x1: 30, z1: 30 })!
      expect(r.blocks).toBe(2)
      expect(r.resized).toBe(true)
      expect(d.terrain.layerCount).toBe(convertLayers(w).layerCount)
      expect(d.terrain.layers).toEqual(convertLayers(w).layers)
      expect(g.layerMap).not.toBe(map0)
      expect(disposed).toBe(true)
      expect((g.layerMap as RawTexture).getSize()).toEqual({ width: CELLS, height: CELLS * d.terrain.layerCount })
      if (mode === 'pbr') {
        expect(g.pbr!.region.layerMap).toBe(g.layerMap)
        expect(g.pbr!.region.layerCount).toBe(d.terrain.layerCount)
      } else {
        expect(((g.material as ShaderMaterial) as unknown as { _textures: Record<string, unknown> })._textures.layerMap).toBe(g.layerMap)
      }
      // and painting it back restores the original planes
      const back = terrain.updateRegion(d.region.id, { words: words(1) })!
      expect(back.resized).toBe(true)
      expect(d.terrain.layerCount).toBe(1)
      expect(d.terrain.layers).toEqual(convertLayers(words(1)).layers)
    })
  }

  it('a new lightmap replaces (and disposes) the old one on both paths', () => {
    for (const mode of ['classic', 'pbr'] as const) {
      const { scene, terrain, data } = setup(mode)
      const d = data(100)
      const lm0 = RawTexture.CreateRGBATexture(new Uint8Array(4).fill(255), 1, 1, scene)
      const g = terrain.buildRegion(d, id => id - 1, lm0)
      const lm1 = RawTexture.CreateRGBATexture(new Uint8Array(4).fill(128), 1, 1, scene)
      const r = terrain.updateRegion(d.region.id, { lightmap: lm1 })!
      expect(r.lightmap).toBe(true)
      expect(g.lightmap).toBe(lm1)
      expect(lm0.getInternalTexture()).toBeNull()
      if (mode === 'pbr') expect(g.pbr!.region.lightmap).toBe(lm1)
    }
  })
})

describe('the layering port (terrain-edit.ts) = the converter\'s blockLayers', () => {
  it('on random words of a few tiles and codes', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296)
    for (let trial = 0; trial < 3; trial++) {
      const w = words(1, () => (rnd() < 0.3 ? (1 + Math.floor(rnd() * 5)) | (Math.floor(rnd() * 3) << 13) : null))
      for (const [bx, bz] of [[0, 0], [3, 2], [5, 5]] as const) {
        const b = new Uint16Array(17 * 17)
        for (let z = 0; z < 17; z++) for (let x = 0; x < 17; x++) b[z * 17 + x] = w[(bz * 16 + z) * GRID + bx * 16 + x]!
        expect(blockLayersOf(w, bx, bz)).toEqual(blockLayers(b))
      }
      const t = { layerCount: 1, textures: words(1), layers: convertLayers(words(1)).layers }
      relayer(t, w)
      const want = convertLayers(w)
      expect(t.layerCount).toBe(want.layerCount)
      expect(t.layers).toEqual(want.layers)
    }
  }, 60_000)

  const dir = new URL('../../../work/out/world/jangan-fields/terrain/', import.meta.url)
  it.skipIf(!existsSync(dir))('rebuilds every exported region\'s layer planes byte for byte from its words', () => {
    let n = 0
    for (const f of readdirSync(dir).filter(f => f.endsWith('.bin'))) {
      const t = decodeTerrainBin(readFileSync(new URL(f, dir)))
      const copy = { layerCount: 1, textures: new Uint16Array(GRID * GRID).fill(0xffff), layers: new Uint8Array(CELLS * CELLS * 4) }
      relayer(copy, t.textures)
      expect(copy.layerCount, f).toBe(t.layerCount)
      expect(Buffer.from(copy.layers).equals(Buffer.from(t.layers)), f).toBe(true)
      n++
    }
    expect(n).toBeGreaterThan(100)
  }, 120_000)
})
