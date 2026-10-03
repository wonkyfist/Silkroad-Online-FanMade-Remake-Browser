/**
 * H-10R adversarial hunt, lens "hitches", the game's side (docs/WAVE_PLAN6.md §9; screens/warmup.ts). The entry's
 * warm-up asks every enabled, VISIBLE mesh to compile, plus the weather's meshes whatever they show (W9F R1: "the
 * first rain after a dry entry must not compile them in play"). Wave 10 added three parts whose meshes are hidden with
 * `isVisible = false` whenever they have nothing to draw, by design (no EnabledMeshCandidates rebuild):
 *   - the ocean (ocean/ocean.ts): invisible while no sea node is inside the fog cut (an entry in town);
 *   - the wildlife (life/life.ts): each of its three meshes is invisible at count 0: the fireflies by day, the
 *     butterflies and birds at night, all of them in rain;
 *   - the grass field tiers (grass/field.ts): invisible at count 0 (a tier with no grassy cell in view).
 * None of them is a weather mesh, so the warm-up skips them and their first draw compiles in play: at the first dusk
 * after a day entry (fireflies), on the way to the beach (the ocean's FFT/PBR material and its depth pre-pass variant,
 * COAST F3 "two effect variants per preset, both to warm up"), and so on.
 * Browser (viewer, jangan-fields, Medium, WebGPU, warm shader cache): the first sight of the sea compiled the ocean's
 * PBR effect and the terrain's SRO_COAST_WET variant in two frames of 25.5 and 16.9 ms CPU (median 1.1 ms); see
 * packages/world-render/test/abuse-w10r-hitches.test.ts. The day-entry fixture below also leaves the butterflies
 * hidden (no meadow in view), so they compile at their first meadow as well.
 * NullEngine. Fixed (HL-2): screens/warmup.ts asks the part meshes (isPartMesh) thin-instanced, and waits for `parts`.
 */
import { FreeCamera, Vector3 } from '@babylonjs/core'
import { createOceanPart, type SroOcean } from '@sro/world-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TOWN, addCoast } from '../../../packages/world-render/test/ocean-fixture.ts'
import { w10World } from '../../../packages/world-render/test/w10-fixture.ts'
import { GraphicsWarmup, meshReady, warmupMeshes } from '../src/screens/warmup.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

describe('the entry warm-up and the wave-10 parts', () => {
  it('a day entry in town warms the ocean and every wildlife mesh (they draw later in play)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = await w10World({
      render: 'pbr', quality: 'medium', grassStyle: 'field',
      parts: { batch: null, ocean: host => createOceanPart(host, { worker: false }) },
      edit: fx => addCoast(fx),
    })
    cleanups.push(s.dispose)
    await s.run()
    const ocean = s.world.ocean as SroOcean
    await ocean.loaded
    const scene = s.scene
    const cam = new FreeCamera('cam', new Vector3((TOWN.x0 + TOWN.x1) / 2, 20, (TOWN.z0 + TOWN.z1) / 2), scene)
    cam.maxZ = 300
    cam.setTarget(new Vector3(TOWN.x0 - 400, 0, (TOWN.z0 + TOWN.z1) / 2))
    scene.activeCamera = cam
    for (let i = 0; i < 30; i++) {
      cam.getViewMatrix(true)
      s.world.ocean?.update(cam, 1 / 60)
      s.world.life?.update(cam, 1 / 60)
    }
    expect(s.world.life, 'the wildlife runs on Medium').not.toBeNull()
    const asked = new Set(warmupMeshes(scene).map(m => m.name))
    const parts = [...ocean.meshes(), ...s.world.life!.meshes()].map(m => m.name)
    expect(parts.length).toBe(4)
    // Every part mesh that exists is compiled by the warm-up, as the weather's are.
    expect(parts.filter(n => !asked.has(n))).toEqual([])
    // In the variant they draw: thin-instanced (the ocean's instance count is 0 with no sea node in view).
    const sea = ocean.meshes()[0]!
    const spy = vi.spyOn(sea, 'isReady')
    meshReady(sea)
    expect(spy).toHaveBeenLastCalledWith(true, true)
  })

  it('the stream stage waits for the parts data (the ocean makes its mesh after its coast field loaded)', async () => {
    const { NullEngine, Scene, ArcRotateCamera } = await import('@babylonjs/core')
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.activeCamera = new ArcRotateCamera('c', 0, 1, 10, Vector3.Zero(), scene)
    cleanups.push(() => engine.dispose())
    let loaded!: () => void
    const parts = new Promise<void>(r => (loaded = r))
    const stages: string[] = []
    const run = new GraphicsWarmup({ scene, engine, camera: { alpha: 0 }, stream: null, parts }, { viewSteps: 0, quietFrames: 1, onProgress: (_f, st) => stages.push(st) }).run()
    const frame = () => scene.render()
    for (let i = 0; i < 5; i++) frame()
    expect(new Set(stages)).toEqual(new Set(['stream']))
    loaded()
    await parts
    for (let i = 0; i < 5; i++) frame()
    expect((await run).ended).toBe('done')
  })
})
