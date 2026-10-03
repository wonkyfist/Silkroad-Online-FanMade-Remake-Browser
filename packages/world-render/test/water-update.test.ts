/**
 * W12-SB, the water block update (docs/WAVE_PLAN8.md §4.3; docs/WORLD_EDITOR.md §4.8): `WaterRenderer.updateRegion`
 * sets a region's block water planes and builds its one water mesh again on the region's shared material (no new
 * material, uniform, sampler or define); with no block change the rebuilt mesh is today's, vertex for vertex.
 */
import { NullEngine, Scene, ShaderMaterial, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { GRID } from '../../convert/src/world/format.ts'
import { Assets } from '../src/assets.ts'
import { CLEAR_RENDER_WEATHER, RENDER_PRESETS, WaterRenderer, type RegionData, type RenderPath, type WorldRegions } from '../src/index.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** Region 5: ground at −2 m everywhere but block (1, 0) at +1 m; block (0, 0) holds water at 0 m. */
function pondRegion(): RegionData {
  const heights = new Float32Array(GRID * GRID).fill(-2)
  for (let gz = 0; gz <= 16; gz++) for (let gx = 16; gx <= 32; gx++) heights[gz * GRID + gx] = 1
  const blocks = Array.from({ length: 36 }, (_, b) => ({
    bx: b % 6, bz: Math.floor(b / 6), flag: 0, environmentId: 0,
    water: b === 0 ? { kind: 'water', type: 0, wave: 3, heightM: 0 } : null,
  }))
  return { region: { id: 5, x: 5, z: 0, origin: [0, 0, 0], blocks }, terrain: { heights }, navmesh: null } as unknown as RegionData
}

async function rig(mode: RenderPath | null) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  const data = pondRegion()
  const world = { manifest: { water: { frames: [], frameMs: 100, ice: null } }, regions: [data], get: (id: number) => (id === 5 ? data : null) } as unknown as WorldRegions
  const water = new WaterRenderer(scene, world)
  cleanups.push(() => water.dispose())
  if (mode) water.follow({ render: { mode, quality: mode === 'pbr' ? RENDER_PRESETS.medium : RENDER_PRESETS.low, weather: CLEAR_RENDER_WEATHER } })
  await water.init(new Assets('http://mem.test/', { bytes: async () => { throw new Error('no assets') }, decodeImage: async () => ({ width: 1, height: 1, data: new Uint8Array(4) }) }))
  return { water, data }
}

const vertices = (m: Mesh) => ({
  pos: [...(m.getVerticesData('position') ?? [])],
  col: [...(m.getVerticesData('color') ?? [])],
  idx: [...(m.getIndices() ?? [])],
})

describe('WaterRenderer.updateRegion', () => {
  for (const mode of [null, 'classic', 'pbr'] as const) {
    it(`${mode ?? 'no renderer'}: a rebuild with no block change is today's mesh; a new pond adds its block; dry removes it`, async () => {
      const { water, data } = await rig(mode)
      const [m0] = water.addRegion(data) as [Mesh]
      const before = vertices(m0)
      const mat = m0.material
      const [m1] = water.updateRegion(5) as [Mesh]
      expect(m1).not.toBe(m0)
      expect(m0.isDisposed()).toBe(true)
      expect(vertices(m1)).toEqual(before)
      expect(m1.material).toBe(mat)
      expect(water.meshes).toEqual([m1])
      // the editor's pond in block (2, 3) at 1 m over the −2 m ground: one water mesh still, 2 blocks of 17 × 17 vertices
      const [m2] = water.updateRegion(5, [{ bx: 2, bz: 3, water: { kind: 'water', type: 0, wave: 1, heightM: 1 } }]) as [Mesh]
      expect(water.meshes).toEqual([m2])
      expect(m2.getTotalVertices()).toBe(2 * 17 * 17)
      expect(data.region.blocks[3 * 6 + 2]!.water).toEqual({ kind: 'water', type: 0, wave: 1, heightM: 1 })
      // a plane over dry ground (block (1, 0) at +1 m, water 0 m) builds no vertices for that block
      water.updateRegion(5, [{ bx: 1, bz: 0, water: { kind: 'water', type: 0, wave: 1, heightM: 0 } }])
      expect(water.meshes[0]!.getTotalVertices()).toBe(2 * 17 * 17)
      // all dry: no mesh at all
      expect(water.updateRegion(5, [{ bx: 0, bz: 0, water: null }, { bx: 2, bz: 3, water: null }, { bx: 1, bz: 0, water: null }])).toEqual([])
      expect(water.meshes).toEqual([])
      if (!mode || mode === 'classic') expect(mat).toBeInstanceOf(ShaderMaterial)
    })
  }

  it('a height stroke under the water changes its depth colour on a rebuild; unloaded regions and bad blocks are refused', async () => {
    const { water, data } = await rig('pbr')
    const [m0] = water.addRegion(data) as [Mesh]
    const col0 = vertices(m0).col
    for (let gz = 0; gz <= 16; gz++) for (let gx = 0; gx <= 16; gx++) (data.terrain.heights as Float32Array)[gz * 97 + gx] = -0.5
    const [m1] = water.updateRegion(5) as [Mesh]
    expect(vertices(m1).col).not.toEqual(col0)
    expect(water.updateRegion(6)).toBeNull()
    expect(() => water.updateRegion(5, [{ bx: 6, bz: 0, water: null }])).toThrow(/outside/)
  })
})
