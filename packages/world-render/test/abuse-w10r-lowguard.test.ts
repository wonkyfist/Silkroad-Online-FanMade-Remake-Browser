/**
 * H-10R, lens "Low changed" (WAVE_PLAN6 §6.5 lens 3, D33): with all five wave-10 items on, a world that goes to Low
 * (the Classic path) must look and compile exactly as a world that was always on Low.
 */
import { FreeCamera, Vector3, type ShaderMaterial } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { COAST_WET_DEFINE, COAST_WET_FIELD, COAST_WET_SHORE, COAST_WET_XF } from '../src/coast/chunks.ts'
import { createOceanPart, SroOcean } from '../src/ocean/index.ts'
import { TERRAIN_SAMPLERS, TERRAIN_UNIFORMS } from '../src/shaders.ts'
import { SHORE_X, addCoast } from './ocean-fixture.ts'
import { w10World } from './w10-fixture.ts'

/** HEAD's lists, read before any world is made in this file. */
const SAMPLERS_AT_LOAD = [...TERRAIN_SAMPLERS]
const UNIFORMS_AT_LOAD = [...TERRAIN_UNIFORMS]

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const hasDefine = (m: ShaderMaterial, name: string) => m.options.defines.some(d => d === name || d.startsWith(`${name} `))

async function frames(ocean: SroOcean, cam: FreeCamera, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) {
    cam.getViewMatrix(true)
    ocean.update(cam, 1 / 60)
    await new Promise(r => setTimeout(r, 0))
  }
}

describe('H-10R lowguard: the coast wet band after a live switch to Low', () => {
  it('Medium at the beach, walk inland (the sea leaves the fog cut), switch to Low: the Classic terrain has no SRO_COAST_WET', async () => {
    const s = await w10World({ render: 'pbr', quality: 'medium', edit: fx => addCoast(fx), parts: { ocean: host => createOceanPart(host, { worker: false }) } })
    cleanups.push(s.dispose)
    const ocean = s.world.ocean as SroOcean
    await ocean.loaded
    await s.run()
    const cam = new FreeCamera('cam', new Vector3(SHORE_X + 60, 25, -50), s.scene)
    cam.maxZ = 2000
    cam.setTarget(new Vector3(SHORE_X + 400, 0, -50))
    s.scene.activeCamera = cam
    s.scene.fogMode = 3
    s.scene.fogStart = 100
    s.scene.fogEnd = 600
    await frames(ocean, cam, 4)
    // On the PBR path at the beach the wet band is installed (shore/index.ts syncTerrain).
    expect(s.world.terrain.sharedUniforms.has(COAST_WET_FIELD)).toBe(true)
    // Walk far inland: no node within the cut, the sea is idle (no shore update).
    cam.position.set(-600, 25, -50)
    cam.setTarget(new Vector3(-200, 0, -50))
    await frames(ocean, cam, 3)
    expect(ocean.stats.nodes).toBe(0)
    // Options → Low (World.setRenderMode('classic') rebuilds every region on the Classic path).
    s.world.setRenderMode('classic')
    await s.run()
    await frames(ocean, cam, 3)
    const classic = s.world.terrain.materials
    expect(classic.length).toBeGreaterThan(0)
    // A world that was always on Low never has the define nor the coast field on its terrain (the Low guard).
    expect(classic.filter(m => hasDefine(m, COAST_WET_DEFINE)).map(m => m.name)).toEqual([])
    expect(s.world.terrain.sharedUniforms.has(COAST_WET_FIELD)).toBe(false)
    expect(classic.filter(m => m.options.samplers.includes(COAST_WET_FIELD)).map(m => m.name)).toEqual([])
    expect(classic.filter(m => m.options.uniforms.includes(COAST_WET_XF) || m.options.uniforms.includes(COAST_WET_SHORE)).map(m => m.name)).toEqual([])
  })

  it('the leftover outlives the world: Babylon kept the shared TERRAIN_SAMPLERS / TERRAIN_UNIFORMS arrays, so a fresh Low world (no coast at all) compiles a different terrain', async () => {
    // Runs after the test above (same module): the Classic terrain materials are made with `samplers: TERRAIN_SAMPLERS`
    // and `uniforms: TERRAIN_UNIFORMS` by reference, and ShaderMaterial.setTexture / setVector4 push unknown names into
    // those arrays, i.e. into the module constants.
    expect(TERRAIN_SAMPLERS.filter(n => !SAMPLERS_AT_LOAD.includes(n))).toEqual([])
    expect(TERRAIN_UNIFORMS.filter(n => !UNIFORMS_AT_LOAD.includes(n))).toEqual([])
    const s = await w10World({ render: 'classic', quality: 'low' })
    cleanups.push(s.dispose)
    await s.run()
    const m = s.world.terrain.materials[0]!
    expect([...m.options.samplers].sort()).toEqual([...SAMPLERS_AT_LOAD].sort())
    expect([...m.options.uniforms].sort()).toEqual([...UNIFORMS_AT_LOAD].sort())
  })
})
