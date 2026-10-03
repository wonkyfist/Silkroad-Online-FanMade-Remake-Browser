// The viewer's town lab (TL-L, docs/TOWN_LIFE.md §12.2; docs/WAVE_PLAN7.md §5.4, §6.1): the LAB-11 town scenes, the
// clock scrub, the counters and roles, and the toggle: World.town dropped and made again by the world's own factory
// (what a Low ↔ Medium switch does) rebuilds without leftovers, cycle after cycle; Town life Off draws nothing; the
// Classic path never gets a part (the Low guard). The GPU parts (the A/B's bench) run in the browser.
import { ArcRotateCamera, MeshBuilder, PBRMaterial, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { stubCrowdAssets } from '../../../packages/world-render/src/town/crowd.ts'
import { plazaStandIn, townPartWith, type TownPlan } from '../../../packages/world-render/src/town/index.ts'
import { w10World, type W10Setup } from '../../../packages/world-render/test/w10-fixture.ts'
import {
  ScrubClock,
  TOWN_SCENES,
  findTownLeftovers,
  formatTownAb,
  formatTownCounters,
  gameScenes,
  rebuildTown,
  roleCounts,
  townCountGrowth,
  townIdle,
  townLeftoverProblems,
  townSceneByName,
  townSceneCounts,
} from '../src/world/town-panel.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

describe('the LAB-11 town scenes (WAVE_PLAN7 §5.4)', () => {
  it('cover the plaza at noon (A/B), the 20-player plaza (G1, 4 repeats), the plaza at night, the market at dusk, the gate in the alarm and the stage', () => {
    expect(new Set(TOWN_SCENES.map(s => s.name)).size).toBe(TOWN_SCENES.length)
    // the plaza view is LAB-10R's, so the town's delta reads against the wave-10r gate
    expect(townSceneByName('plaza-noon')).toMatchObject({ x: 101, z: -70, time: 0.5, weather: 'clear' })
    expect(townSceneByName('plaza-noon')!.gameOnly).toBeUndefined()
    expect(townSceneByName('plaza-crowd-bots')).toMatchObject({ x: 101, z: -70, repeats: 4 })
    expect(townSceneByName('plaza-crowd-bots')!.gameOnly).toBeTruthy()
    const night = townSceneByName('plaza-night')!.time
    expect(night < 5 / 24 || night > 20 / 24).toBe(true)
    // dusk: inside the lantern carriers' hours (18–20)
    const dusk = townSceneByName('market-dusk')!.time * 24
    expect(dusk).toBeGreaterThanOrEqual(18)
    expect(dusk).toBeLessThan(20)
    expect(townSceneByName('gate-alarm')!.alarm).toBe(true)
    expect(townSceneByName('stage')!.gameOnly).toBeTruthy()
    expect(townSceneByName('nowhere')).toBeUndefined()
  })

  it('give the game harness /tp lines, the look and the hour', () => {
    const g = gameScenes()
    expect(g).toHaveLength(TOWN_SCENES.length)
    expect(g.find(s => s.name === 'plaza-noon')).toMatchObject({ tp: '/tp 101 -70', look: 'north', hour: 12, alarm: false, repeats: 1 })
    expect(g.find(s => s.name === 'gate-alarm')).toMatchObject({ look: 'south', alarm: true })
    expect(g.find(s => s.name === 'market-dusk')).toMatchObject({ tp: '/tp 98 -130', look: 'north', hour: 19 })
    expect(g.find(s => s.name === 'stage')!.tp).toBeNull()
  })
})

describe('the clock scrub', () => {
  it('runs on page time, shifts by the offset, holds when frozen, runs on at a rate without a jump, resets', () => {
    let real = 1_780_000_000
    const c = new ScrubClock(() => real)
    expect(c.now()).toBe(real)
    real += 10
    expect(c.now()).toBe(1_780_000_010)
    c.setOffset(-600)
    expect(c.now()).toBe(1_780_000_010 - 600)
    c.freeze(true)
    real += 100
    expect(c.now()).toBe(1_780_000_010 - 600)
    // frozen, the scrub still moves it (a held pose can be stepped)
    c.setOffset(-599)
    expect(c.now()).toBe(1_780_000_010 - 599)
    c.freeze(false)
    expect(c.now()).toBe(1_780_000_010 - 599)
    real += 5
    expect(c.now()).toBe(1_780_000_015 - 599)
    c.setRate(4)
    expect(c.now()).toBe(1_780_000_015 - 599)
    real += 2
    expect(c.now()).toBe(1_780_000_015 + 8 - 599)
    expect(c.fn()).toBe(c.now())
    c.setRate(Number.NaN)
    expect(c.rate).toBe(1)
    c.reset()
    expect(c.now()).toBe(real)
    expect(c.frozen).toBe(false)
    expect(c.offsetS).toBe(0)
  })
})

/** A world with TL-C's real part on the plaza stand-in and the stand-in assets (no network). */
async function townWorld(render: 'pbr' | 'classic' = 'pbr'): Promise<W10Setup> {
  const plan = plazaStandIn({ manifest: { name: 'jangan-fields' } } as never) as TownPlan
  const make = townPartWith({ plan: () => plan, assets: (s, d) => stubCrowdAssets(s, d) })
  const s = await w10World({ render, parts: { batch: null, ocean: null, town: make } })
  cleanups.push(s.dispose)
  return s
}

function camera(s: W10Setup): ArcRotateCamera {
  return new ArcRotateCamera('town-lab-test', Math.PI / 2, 1.2, 12, new Vector3(99, 0, -82), s.scene)
}

/** Frames of the world (the town's update) at the plaza at a fixed clock. */
function frames(s: W10Setup, cam: ArcRotateCamera, n = 8): void {
  for (let k = 0; k < n; k++) s.world.update(cam, new Vector3(99, 0, -82))
}

describe('the counters and the roles', () => {
  it('list the folk, the animals, the draws and the agents of each role, drawn and in the plan', async () => {
    const s = await townWorld()
    const cam = camera(s)
    const clock = new ScrubClock(() => 1_780_000_000)
    s.world.town!.setClock(clock.fn)
    frames(s, cam)
    const roles = roleCounts(s.world.town)
    expect(roles.length).toBeGreaterThan(2)
    const total = roles.reduce((a, r) => a + r.total, 0)
    const plan = (s.world.town as unknown as { plan: TownPlan }).plan
    expect(total).toBe(plan.folk.agents.length + ((s.world.town as unknown as { animalSchedule?: { agents: unknown[] } }).animalSchedule?.agents.length ?? 0))
    const drawn = roles.reduce((a, r) => a + r.drawn, 0)
    const st = s.world.town!.stats()
    expect(drawn).toBe((st.folk ?? 0) + (st.animals ?? 0))
    expect(drawn).toBeGreaterThan(0)
    for (const r of roles) expect(r.drawn).toBeLessThanOrEqual(r.total)
    const lines = formatTownCounters(s.world, 100, clock)
    expect(lines[0]).toMatch(/part live · drawn · Town life full/)
    expect(lines.join('\n')).toMatch(/folk {6}\d+ drawn \/ cap \d+/)
    expect(lines.join('\n')).toMatch(/roles {4}/)
    expect(roleCounts(null)).toEqual([])
  })

  it('format an A/B row with the deltas and the problems', () => {
    const sample = (cpu: number) => ({ label: '', width: 1920, height: 1080, wallMs: cpu + 1, cpuMs: cpu, gpuPassMs: null })
    const row = formatTownAb([{
      scene: 'plaza-noon', preset: 'medium', backend: 'WebGPU', draws: { off: 150, on: 166 },
      town: { folk: 58, animals: 10, draws: 16, updateMs: 0.4 }, bench: { off: sample(3), on: sample(3.5) }, problems: [],
    }])
    expect(row).toMatch(/plaza-noon \[WebGPU medium\]: draws 150 → 166/)
    expect(row).toMatch(/Δ cpu \+0\.50/)
    expect(row).not.toMatch(/PROBLEMS/)
  })
})

describe('the toggle rebuilds without leftovers (World.town dropped and made again by the world\'s factory)', () => {
  it('off leaves no part, town mesh, town material or TAA override; on draws again; the scene does not grow per cycle', async () => {
    const s = await townWorld()
    const cam = camera(s)
    const clock = new ScrubClock(() => 1_780_000_000)
    s.world.town!.setClock(clock.fn)
    frames(s, cam)
    const first = findTownLeftovers(s.scene, s.world)
    expect(first.part).toBe(true)
    expect(first.townMeshes).toBeGreaterThan(0)
    expect(first.drawnMeshes).toBeGreaterThan(0)
    expect(townLeftoverProblems(first, 'on')).toEqual([])
    expect(townIdle(s.world.town)).toBe(true)

    let offCounts = null as ReturnType<typeof townSceneCounts> | null
    let onCounts = null as ReturnType<typeof townSceneCounts> | null
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(rebuildTown(s.world, false)).toBeNull()
      frames(s, cam, 2)
      const off = findTownLeftovers(s.scene, s.world)
      expect(townLeftoverProblems(off, 'gone')).toEqual([])
      expect(formatTownCounters(s.world, 0)).toHaveLength(1)
      const oc = townSceneCounts(s.scene, s.world)
      if (offCounts) expect(townCountGrowth(offCounts, oc)).toEqual([])
      offCounts = oc

      const part = rebuildTown(s.world, true, clock.fn)
      expect(part).not.toBeNull()
      expect(s.world.town).toBe(part)
      // the same part comes back on a second call
      expect(rebuildTown(s.world, true, clock.fn)).toBe(part)
      frames(s, cam)
      const on = findTownLeftovers(s.scene, s.world)
      expect(townLeftoverProblems(on, 'on')).toEqual([])
      expect(on.drawnMeshes).toBeGreaterThan(0)
      expect(part!.stats().folk).toBeGreaterThan(0)
      const nc = townSceneCounts(s.scene, s.world)
      if (onCounts) expect(townCountGrowth(onCounts, nc)).toEqual([])
      onCounts = nc
    }
    // the off state has fewer of everything the town makes
    expect(offCounts!.meshes).toBeLessThan(onCounts!.meshes)
    // TL-B's dressing props are world objects with `town_*` materials: not leftovers; a `town:` material on nothing is
    rebuildTown(s.world, false)
    const prop = MeshBuilder.CreateBox('dressing-prop', { size: 1 }, s.scene)
    prop.material = new PBRMaterial('town_bench', s.scene)
    expect(findTownLeftovers(s.scene, s.world).townMaterials).toBe(0)
    const orphan = new PBRMaterial('town:orphan', s.scene)
    expect(townLeftoverProblems(findTownLeftovers(s.scene, s.world), 'gone')).toEqual(['1 town material(s) left without a part'])
    orphan.dispose()
    prop.material.dispose()
    prop.dispose()
  })

  it('Town life Off keeps the part but draws nothing; Low halves the cap; Full again draws', async () => {
    const s = await townWorld()
    const cam = camera(s)
    s.world.town!.setClock(() => 1_780_000_000)
    frames(s, cam)
    const fullCap = s.world.town!.stats().cap!
    s.world.setTownLife('off')
    frames(s, cam, 2)
    const hidden = findTownLeftovers(s.scene, s.world)
    expect(hidden.part).toBe(true)
    expect(townLeftoverProblems(hidden, 'hidden')).toEqual([])
    expect(hidden.drawnMeshes).toBe(0)
    s.world.setTownLife('low')
    frames(s, cam)
    expect(s.world.town!.stats().cap).toBeLessThan(fullCap)
    s.world.setTownLife('full')
    frames(s, cam)
    expect(s.world.town!.stats().cap).toBe(fullCap)
    expect(findTownLeftovers(s.scene, s.world).drawnMeshes).toBeGreaterThan(0)
    // a part rebuilt while Town life is Off comes back hidden
    s.world.setTownLife('off')
    rebuildTown(s.world, false)
    const again = rebuildTown(s.world, true)!
    frames(s, cam, 2)
    expect(again.enabled).toBe(false)
    expect(townLeftoverProblems(findTownLeftovers(s.scene, s.world), 'hidden')).toEqual([])
  })

  it('Classic: no part, and the toggle refuses to make one (the Low guard); a path switch leaves nothing the panel finds', async () => {
    const c = await townWorld('classic')
    expect(c.world.town).toBeNull()
    expect(rebuildTown(c.world, true)).toBeNull()
    expect(c.world.town).toBeNull()
    expect(townLeftoverProblems(findTownLeftovers(c.scene, c.world), 'gone')).toEqual([])
    expect(formatTownCounters(c.world, 0)[0]).toMatch(/Classic \(no town: the Low guard\)/)

    const s = await townWorld()
    const cam = camera(s)
    s.world.town!.setClock(() => 1_780_000_000)
    frames(s, cam)
    s.world.setRenderMode('classic')
    expect(townLeftoverProblems(findTownLeftovers(s.scene, s.world), 'gone')).toEqual([])
    s.world.setRenderMode('pbr')
    expect(s.world.town).not.toBeNull()
  })
})
