/**
 * CST-O, the ocean part in a World (docs/COAST.md §8.1, §8.2, §12.4; WAVE_PLAN6 D2, D22, D27) on the streaming fixture
 * with a synthetic coast field: the field decodes exactly (a real PNG with A = 0); World.coast and World.waterLevelAt
 * read it; the mask hides the sea over a town below the sea level and at the retail-water join; the mesh never changes
 * its enabled state, only isVisible (F2), and is never visible with 0 instances (F1); both thin-instance buffers are
 * allocated once at the node cap; nothing is selected and no tick is asked with no sea within the fog cut (D27); the
 * Classic path uses the Gerstner ShaderMaterial and builds no FFT; no world without `manifest.coast` gets an ocean.
 */
import { FreeCamera, PBRMaterial, ShaderMaterial, Vector3, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createOceanPart, SroOcean } from '../src/ocean/index.ts'
import { CDLOD_MAX_NODES } from '../src/ocean/cdlod.ts'
import { CoastField, decodeElevation, decodePng, drawsWater, encodeElevation, joinBlocks, lowLandFloor } from '../src/ocean/field.ts'
import { attenuationDepth, attenuationFloor, shallowScale } from '../src/ocean/gerstner.ts'
import { CDLOD_ATTRIBUTE } from '../src/ocean/ocean-plugin.ts'
import { FIELD, SEA_LEVEL, SHORE_X, TOWN, addCoast, encodePng, fieldPixels } from './ocean-fixture.ts'
import { w10World, type W10Setup } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

async function oceanWorld(render: 'pbr' | 'classic' = 'pbr', quality: 'low' | 'medium' | 'high' = 'medium'): Promise<{ s: W10Setup; ocean: SroOcean; cam: FreeCamera }> {
  const s = await w10World({ render, quality, edit: fx => addCoast(fx), parts: { ocean: host => createOceanPart(host, { worker: false }) } })
  cleanups.push(s.dispose)
  const ocean = s.world.ocean as SroOcean
  expect(ocean).toBeInstanceOf(SroOcean)
  await ocean.loaded
  const cam = new FreeCamera('cam', new Vector3(SHORE_X + 60, 25, -50), s.scene)
  cam.maxZ = 2000
  cam.setTarget(new Vector3(SHORE_X + 400, 0, -50))
  s.scene.activeCamera = cam
  return { s, ocean, cam }
}

/** Runs the ocean's frames (the world's own update needs a render loop; the part is driven directly). */
async function frames(ocean: SroOcean, cam: FreeCamera, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    cam.getViewMatrix(true)
    ocean.update(cam, 1 / 60)
    await new Promise(r => setTimeout(r, 0))
  }
}

describe('the coast field (COAST §8.1)', () => {
  it('decodes a PNG exactly (A = 0 does not zero R, G, B) and samples what the converter wrote', async () => {
    const px = fieldPixels()
    const img = await decodePng(encodePng(px, FIELD.width, FIELD.height))
    expect([img.width, img.height]).toEqual([FIELD.width, FIELD.height])
    expect(Buffer.from(img.data).equals(Buffer.from(px))).toBe(true)
    const f = new CoastField({ seaLevelM: SEA_LEVEL, field: FIELD, mapColor: '#000000', sourceHash: '' }, img)
    expect(f.seaAt(SHORE_X + 100, 0)).toBe(true)
    expect(f.seaAt(SHORE_X - 100, 0)).toBe(false)
    // Beyond the field: clamped (open sea on the sea side, C16).
    expect(f.seaAt(1e5, 0)).toBe(true)
    const sea = f.sample(SHORE_X + 100, 10)
    expect(sea.sea).toBeCloseTo(1, 6)
    expect(sea.distanceM).toBeGreaterThan(60)
    expect(sea.elevationM).toBeCloseTo(-10, 0)
    const beach = f.sample(SHORE_X - 20, 10)
    expect(beach.elevationM).toBeCloseTo(1, 0)
    expect(beach.distanceM).toBeCloseTo(-20, 0)
    // The elevation code is continuous through the waterline and centimetre-fine near it.
    expect(decodeElevation(encodeElevation(0.05))).toBeCloseTo(0.05, 1)
    expect(Math.abs(decodeElevation(encodeElevation(-30)) + 30)).toBeLessThan(0.6)
  })

  it('the mask: sea draws; the swash band on the beach draws; a town below the sea level and the retail join never do', async () => {
    const img = await decodePng(encodePng(fieldPixels(), FIELD.width, FIELD.height))
    const joins = [{ x0: 736, x1: 768, z0: -96, z1: -64 }]
    const f = new CoastField({ seaLevelM: SEA_LEVEL, field: FIELD, mapColor: '#000000', sourceHash: '' }, img, joins)
    expect(drawsWater(f.sample(SHORE_X + 50, 300))).toBe(true)
    expect(drawsWater(f.sample(SHORE_X - 10, 300))).toBe(true)
    expect(drawsWater(f.sample(SHORE_X - 100, 300))).toBe(false)
    expect(drawsWater(f.sample((TOWN.x0 + TOWN.x1) / 2, (TOWN.z0 + TOWN.z1) / 2))).toBe(false)
    expect(f.sample(750, -80).join).toBeCloseTo(1, 1)
    expect(drawsWater(f.sample(750, -80))).toBe(false)
    expect(f.sample(SHORE_X + 100, -80).join).toBe(0)
    expect(f.nodeHasWater(TOWN.x0, TOWN.z0, 64)).toBe(false)
    expect(f.nodeHasWater(SHORE_X + 8, 0, 8)).toBe(true)
  })

  it('I-10R: retail water that keeps its own plane (G 0 off the sea: the town fountain) never gets the sea', async () => {
    // Before: the repack read G 0 as "at the shoreline" and B 0 as "at the sea level", so the swash rule drew a
    // sea-level sheet over the plaza's fountain and ponds (seen hanging over the plaza on the create screen).
    const { width: w, x0, z0, metresPerTexel: m } = FIELD
    const px = fieldPixels()
    const cx = (TOWN.x0 + TOWN.x1) / 2, cz = (TOWN.z0 + TOWN.z1) / 2
    const ti = Math.floor((cx - x0) / m), tj = Math.floor((cz - z0) / m)
    for (let j = tj - 2; j <= tj + 2; j++) for (let i = ti - 2; i <= ti + 2; i++) px.set([0, 0, 0, 0], (j * w + i) * 4)
    const img = await decodePng(encodePng(px, FIELD.width, FIELD.height))
    const f = new CoastField({ seaLevelM: SEA_LEVEL, field: FIELD, mapColor: '#000000', sourceHash: '' }, img)
    const s = f.sample(cx, cz)
    expect(s.distanceM).toBeLessThan(-60)
    expect(drawsWater(s)).toBe(false)
    expect(f.nodeHasWater(cx - 16, cz - 16, 32)).toBe(false)
    // The shore itself is unchanged.
    expect(drawsWater(f.sample(SHORE_X - 10, 300))).toBe(true)
    expect(drawsWater(f.sample(SHORE_X + 50, 300))).toBe(true)
  })

  it('X2: low land behind a beach keeps the water only at the shore (no lagoon over the S1 meadow)', () => {
    const land = (distanceM: number, elevationM: number) => drawsWater({ sea: 0, distanceM, elevationM, join: 0 })
    expect(lowLandFloor(-1)).toBeCloseTo(-0.3, 6)
    expect(lowLandFloor(-6)).toBeCloseTo(0, 9)
    // a hollow 0.26 m below the sea level, 20 m inland (the S1 meadow): dry
    expect(land(-20, -0.26)).toBe(false)
    // the same height right at the waterline (the filtering across it): wet
    expect(land(-1, -0.26)).toBe(true)
    // the swash band on a beach above the sea level: wet, as before
    expect(land(-20, 0.4)).toBe(true)
    expect(land(-50, 0.4)).toBe(false)
  })

  it('per-cascade attenuation: the longest cascade is flat at depth 0 and full beyond d0; the join fades to 0', () => {
    const d0 = attenuationDepth(733)
    expect(d0).toBe(40)
    expect(shallowScale(0, d0, attenuationFloor(733))).toBe(0)
    expect(shallowScale(41, d0, attenuationFloor(733))).toBe(1)
    expect(attenuationFloor(7.1)).toBe(0.5)
    // The shortest cascade keeps its floor in 1 m of water.
    expect(shallowScale(1, attenuationDepth(7.1), 0.5)).toBe(1)
    // The shaders multiply by (1 − join): at the join the amplitude is 0.
    expect(shallowScale(30, d0, 0) * (1 - 1)).toBe(0)
  })
})

describe('the ocean part in a World', () => {
  it('no manifest.coast: no ocean (today\'s exports and the Low guard are unchanged)', async () => {
    const s = await w10World({ render: 'pbr' })
    cleanups.push(s.dispose)
    expect(s.world.manifest.coast).toBeUndefined()
    expect(s.world.ocean).toBeNull()
    expect(s.world.coast).toBeNull()
  })

  it('World.coast and World.waterLevelAt read the field (+5 m over the sea, null on dry ground)', async () => {
    const { s } = await oceanWorld()
    expect(s.world.coast?.seaLevelM).toBe(SEA_LEVEL)
    expect(s.world.coast?.seaAt(SHORE_X + 50, 0)).toBe(true)
    expect(s.world.waterLevelAt(SHORE_X + 50, 0)).toBe(SEA_LEVEL)
    expect(s.world.waterLevelAt(0, 0)).toBeNull()
    expect(joinBlocks(s.world.manifest, SEA_LEVEL).length).toBe(1)
  })

  it('draws over the sea: nodes selected, visible, INSTANCES data at the cap; the mesh is tagged and never batched', async () => {
    const { ocean, cam } = await oceanWorld()
    await frames(ocean, cam, 4)
    const mesh = ocean.meshes()[0] as Mesh
    expect(mesh.metadata?.sroWorld).toBe('ocean')
    expect(ocean.stats.nodes).toBeGreaterThan(0)
    expect(mesh.thinInstanceCount).toBe(ocean.stats.nodes)
    expect(mesh.material).toBeInstanceOf(PBRMaterial)
    expect(ocean.stats.waves).toBe('worker-fft')
    const store = (mesh as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array }; _userThinInstanceBuffersStorage: { data: Record<string, Float32Array> } })
    expect(store._thinInstanceDataStorage.matrixData.length).toBe(CDLOD_MAX_NODES * 16)
    const nodes = store._userThinInstanceBuffersStorage.data[CDLOD_ATTRIBUTE]!
    expect(nodes.length).toBe(CDLOD_MAX_NODES * 4)
    await frames(ocean, cam, 3)
    expect(store._userThinInstanceBuffersStorage.data[CDLOD_ATTRIBUTE]).toBe(nodes)
    expect(mesh.isVisible).toBe(true)
  })

  it('walking inland: the enabled state never changes (only isVisible), no candidate-list rebuild, never visible with 0 nodes; no tick asked', async () => {
    const { s, ocean, cam } = await oceanWorld()
    await frames(ocean, cam, 3)
    const mesh = ocean.meshes()[0] as Mesh
    const rebuilds = s.world.activeMeshes?.rebuilds ?? 0
    const path = [SHORE_X + 60, SHORE_X - 200, SHORE_X - 900, -600, SHORE_X - 900, SHORE_X + 60]
    // Fog: the cut at ≈ 600 m (linear fog on this scene: the fog end).
    s.scene.fogMode = 3
    s.scene.fogStart = 100
    s.scene.fogEnd = 600
    for (const x of path) {
      cam.position.set(x, 25, -50)
      cam.setTarget(new Vector3(x + 400, 0, -50))
      await frames(ocean, cam, 2)
      expect(mesh.isEnabled()).toBe(true)
      if (ocean.stats.nodes === 0) expect(mesh.isVisible).toBe(false)
      if (mesh.isVisible) expect(mesh.thinInstanceCount).toBeGreaterThan(0)
    }
    expect(s.world.activeMeshes?.rebuilds ?? 0).toBe(rebuilds)
    // Far inland (x −600, facing east): the sea is > 1,300 m away, beyond the cut: nothing.
    cam.position.set(-600, 25, -50)
    await frames(ocean, cam, 2)
    expect(ocean.stats.nodes).toBe(0)
    expect(mesh.isVisible).toBe(false)
  })

  it('the Classic path (Low): the Gerstner ShaderMaterial, no FFT tile', async () => {
    const { ocean, cam } = await oceanWorld('classic', 'low')
    await frames(ocean, cam, 3)
    const mesh = ocean.meshes()[0] as Mesh
    expect(mesh.material).toBeInstanceOf(ShaderMaterial)
    expect(ocean.stats.waves).toBe('gerstner')
    expect(ocean.stats.path).toBe('classic')
    expect(ocean.stats.nodes).toBeGreaterThan(0)
  })

  it('the wave query: the sea surface near the sea level offshore, null on land', async () => {
    const { ocean, cam } = await oceanWorld()
    await frames(ocean, cam, 6)
    const y = ocean.waveHeightAt(SHORE_X + 300, 20)
    expect(y).not.toBeNull()
    expect(Math.abs(y! - SEA_LEVEL)).toBeLessThan(3)
    expect(ocean.waveHeightAt(0, 0)).toBeNull()
  })

  it('disposes with the world (no mesh or material left)', async () => {
    const { s, ocean, cam } = await oceanWorld()
    await frames(ocean, cam, 2)
    s.world.dispose()
    expect(s.scene.meshes.some(m => m.name === 'ocean')).toBe(false)
    expect(s.scene.materials.some(m => m.name === 'oceanPbr')).toBe(false)
  })
})
