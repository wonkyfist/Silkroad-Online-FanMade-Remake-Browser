/**
 * H-10R adversarial hunt, lens "hitches" (docs/WAVE_PLAN6.md §9, "a region commit carrying a batch merge, a grass bake
 * and a coast region hitches"; H-10R lens 5). Every test states what the wave's docs promise about work landing in
 * play and shows where it does not hold. NullEngine only; no product code is changed by this file.
 *
 * 1. (render) The coast's terrain wet band (shore/index.ts) turns `SRO_COAST_WET` on on EVERY terrain material the
 *    first frame the ocean selects a sea node, not when the coast field loads. In the game that is the moment the sea
 *    comes inside the fog cut while walking to the beach (or the camera turns towards it), long after the entry's
 *    warm-up compiled the terrain without it: every resident region's terrain material (town included) gets a new
 *    define set at once and compiles in play (WebGPU: new render pipelines; WebGL2: programs).
 *    The real jangan-fields export: the nearest sea is 1,016 m south of the town spawn and Medium's fog cut at noon is
 *    356 m, so an entry in town (or anywhere in the fields) never selects a sea node and the warm-up never sees the
 *    define. Viewer, Medium, WebGPU, camera at (96.9, 25, -840) turned from north to south (H-10R, 2026-10-01, GPU
 *    lock held): the first two frames with the sea took 25.5 ms and 16.9 ms of CPU (median 1.1 ms), 2 effects and 2
 *    render pipelines (the ocean's own first compile, apps/game/test/abuse-w10r-hitches.test.ts, and the terrain with
 *    SRO_COAST_WET). The flip alone (Shore.syncTerrain(true) at a quiet spot): one 16.8 ms frame on WebGPU (2
 *    pipelines), one 12.4 ms frame on WebGL2 (1 program), against a 1.3-1.7 ms median, with a warm browser shader cache.
 */
import { FreeCamera, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOceanPart, SroOcean } from '../src/ocean/index.ts'
import { SHORE_X, TOWN, addCoast } from './ocean-fixture.ts'
import { w10World, type W10Setup } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

async function coastWorld(): Promise<W10Setup> {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const s = await w10World({
    render: 'pbr', quality: 'medium', grassStyle: 'field',
    parts: { batch: null, ocean: host => createOceanPart(host, { worker: false }) },
    edit: fx => addCoast(fx),
  })
  cleanups.push(s.dispose)
  await s.run()
  await (s.world.ocean as SroOcean).loaded
  return s
}

describe('the coast wet band is decided in play, not at load', () => {
  it('SRO_COAST_WET reaches the terrain only when the sea first comes into view (a terrain-wide recompile after the warm-up)', async () => {
    const s = await coastWorld()
    const scene = s.scene
    const defines: Array<[string, boolean]> = []
    const terrain = s.world.terrain
    const orig = terrain.setDefine.bind(terrain)
    terrain.setDefine = (name: string, on: boolean) => {
      defines.push([name, on])
      orig(name, on)
    }
    const ocean = s.world.ocean as SroOcean
    const shore = () => (ocean as unknown as { shore: { terrainWet: boolean } | null }).shore
    expect(shore()).not.toBeNull()
    // In town, looking inland (west), the fog cut short of the sea: the entry, its warm-up and the first minutes of play.
    const cam = new FreeCamera('cam', new Vector3((TOWN.x0 + TOWN.x1) / 2, 20, (TOWN.z0 + TOWN.z1) / 2), scene)
    cam.maxZ = 300
    cam.setTarget(new Vector3(TOWN.x0 - 400, 0, (TOWN.z0 + TOWN.z1) / 2))
    scene.activeCamera = cam
    const frame = () => {
      cam.getViewMatrix(true)
      ocean.update(cam, 1 / 60)
    }
    for (let i = 0; i < 30; i++) frame()
    expect(ocean.stats.nodes, 'no sea node inside the cut at the entry').toBe(0)
    const atEntry = shore()!.terrainWet
    const definesAtEntry = defines.length
    // Later in play: the player walks to the beach and looks at the sea.
    cam.position.set(SHORE_X - 60, 25, -50)
    cam.setTarget(new Vector3(SHORE_X + 400, 0, -50))
    for (let i = 0; i < 3; i++) frame()
    expect(ocean.stats.nodes).toBeGreaterThan(0)
    // What the warm-up compiled must be what play draws: the define is set once the field is loaded (before the first
    // frame), not on the first frame with a sea node. Fails: atEntry false, then [['SRO_COAST_WET', true]] in play.
    expect({ atEntry, flippedInPlay: defines.slice(definesAtEntry) }).toEqual({ atEntry: true, flippedInPlay: [] })
  })
})
