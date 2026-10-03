/**
 * H-11 adversarial hunt (docs/WAVE_PLAN7.md §6.6 lens 10, "hitches"), the game's side. Read-only: no product code is
 * changed by this file.
 *
 * FINDING (H11-HI-1): the first townsperson compiles in play when the town's drawables arrive after the entry warm-up.
 * The town part loads its drawables asynchronously (town/crowd.ts loadCrowdAssets: index.json, then each of the 12
 * skeletons' VAT json + bin, then each of the 29 variant glbs, every request AWAITED IN SEQUENCE: 54 round trips,
 * ≈ 5.2 MB brotli in work/out-opt/town). Its warm-up hook (town/index.ts `warm`) answers "not ready" while that runs,
 * but the entry warm-up (screens/warmup.ts):
 *   - does not wait for it in `stream` (the world screen's `parts` is the ocean's `loaded` only), and
 *   - leaves `shaders` once no MESH became ready for `stallMs` (4 s), whatever the hooks say;
 * and nothing asks the hook again once the overlay is gone (runWarmupHooks runs only inside the warm-up). So on a link
 * where the 54 sequential requests take longer than the stream stage + 4 s (a friend over the internet), the crowd's
 * effects (and on WebGPU their pipelines) are made at the first frame a townsperson is in range, in play.
 *
 * The control below (the drawables already there) shows the method: the same frames create no effect.
 */
import { ArcRotateCamera, NullEngine, Scene, Vector3, type Material } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubCrowdAssets, type CrowdAgent, type CrowdAssets, type CrowdPose, type CrowdQuery, type CrowdSchedule } from '../../../packages/world-render/src/town/crowd.ts'
import { TownLife, type TownPlan } from '../../../packages/world-render/src/town/index.ts'
import { DEFAULT_LINES } from '../../../packages/world-render/src/town/bubbles.ts'
import type { World } from '@sro/world-render'
import { GraphicsWarmup, WARMUP_DEFAULTS } from '../src/screens/warmup.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  vi.restoreAllMocks()
})

const NOON_2026 = 1_790_000_000 + 4 * 3600

/** Ten townsfolk standing on a 6 m ring round the origin (the camera's target). */
class Ring implements CrowdSchedule {
  readonly agents: CrowdAgent[] = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, role: 'walker', female: i % 2 === 1, rank: (i + 0.5) / 10 }))
  pose(i: number, q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    const a = i * 0.6
    out.x = Math.cos(a) * 6
    out.y = 0
    out.z = Math.sin(a) * 6
    out.yaw = a
    out.alpha = 1
    out.rate = 1
    out.clip = 'STAND1'
    out.clipT = q.nowS + i * 0.37
    out.distM = Number.NaN
    out.speed = 0
    return true
  }
}

const plan = (): TownPlan => ({
  folk: new Ring(), routes: { segments: new Float32Array(0), spots: new Float32Array(0) }, plaza: null, animals: null, pond: null,
  lines: DEFAULT_LINES as TownPlan['lines'], area: { x: 0, z: 0, r: 50 },
})

function fakeWorld(scene: Scene): World {
  return {
    scene, quality: 'medium', manifest: { name: 'test' }, heightAt: () => 0, waterLevelAt: () => null, skyState: { t: 0.5 },
    weatherState: { rain: 0 }, life: null, render: { post: null }, materials: null, worldClock: null, assets: null,
  } as unknown as World
}

/**
 * A world entry: the town part with drawables that arrive after `assetsAfterMs` (null: at once), the entry warm-up on
 * a test clock (100 ms a frame), then `playFrames` frames of play. Returns the effects created during play.
 */
async function entry(assetsAfterMs: number | null): Promise<{ ended: string; folkAtEnd: boolean; playEffects: number; drawn: number }> {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const camera = new ArcRotateCamera('cam', -Math.PI / 2, 1.1, 12, Vector3.Zero(), scene)
  scene.activeCamera = camera
  let clock = 0
  let deliver: (() => void) | null = null
  const assets = (s: Scene, d: (m: Material) => void): CrowdAssets | Promise<CrowdAssets> => {
    if (assetsAfterMs === null) return stubCrowdAssets(s, d)
    return new Promise<CrowdAssets>(r => (deliver = () => r(stubCrowdAssets(s, d))))
  }
  const town = new TownLife({ scene, world: fakeWorld(scene) }, { plan: () => plan(), assets })
  town.setClock(() => NOON_2026 + clock / 1000)
  cleanups.push(() => {
    town.dispose()
    scene.dispose()
    engine.dispose()
  })
  const frame = async () => {
    clock += 100
    if (deliver && assetsAfterMs !== null && clock >= assetsAfterMs) {
      const d = deliver
      deliver = null
      d()
      await Promise.resolve()
      await Promise.resolve()
    }
    town.update(camera, 0.1)
    scene.render()
    await Promise.resolve()
  }
  // screens/world.ts runWarmup: stream (no streamer here; the parts promise is the ocean's: none), shaders, settle.
  const run = new GraphicsWarmup(
    { scene, engine, camera, stream: null, parts: null },
    { now: () => clock, viewSteps: 0, quietFrames: 2, pipelines: null, gpuQueue: null, stallMs: WARMUP_DEFAULTS.stallMs, maxMs: WARMUP_DEFAULTS.maxMs },
  )
  let result: { ended: string } | null = null
  void run.run().then(r => (result = r))
  for (let i = 0; i < 400 && !result; i++) await frame()
  const folkAtEnd = !!town.folk
  // Play: the drawables arrive (if they had not), townsfolk stand in range of the player.
  const create = vi.spyOn(engine, 'createEffect')
  for (let i = 0; i < 80; i++) await frame()
  return { ended: result?.ended ?? 'running', folkAtEnd, playEffects: create.mock.calls.length, drawn: town.folk?.frame.drawn ?? 0 }
}

describe('H11-HI-1: the first townsperson after the entry warm-up', () => {
  it('control: drawables there at the entry: the warm-up compiles the crowd, play creates no effect', async () => {
    const r = await entry(null)
    expect(r.ended).toBe('done')
    expect(r.drawn).toBeGreaterThan(0)
    expect(r.playEffects).toBe(0)
  })

  it('drawables arriving 6 s into the entry (54 sequential requests on a remote link): still no effect made in play', async () => {
    const r = await entry(6000)
    expect(r.drawn, 'the townsfolk are drawn in play').toBeGreaterThan(0)
    // The warm-up waited for the town (its hook said "not ready"), or the crowd was warmed when it arrived.
    expect({ warmupEndedWithCrowd: r.folkAtEnd, effectsCreatedInPlay: r.playEffects }).toEqual({ warmupEndedWithCrowd: true, effectsCreatedInPlay: 0 })
  })
})
