/**
 * H-11 adversarial hunt (docs/WAVE_PLAN7.md §6.6 lens 9, "the click and the HUD"), world-render's side: the crowd's CPU
 * pick (town/crowd.ts TownCrowd.pick, reached through TownLife.pickFolk by the app's hover and click).
 *
 * FINDING (H11-CH-2): the pick tests the ray against the side of a vertical capsule only (radius 0.4 m, the agent's
 * height): a hit counts only where the ray crosses the cylinder's SIDE between the feet and the head. A view ray that
 * enters through the top (the head) and leaves through the bottom (the feet) never crosses the side inside that band,
 * so it misses. The world camera may look down to `lowerBetaLimit` 0.25 rad (14° from vertical; screens/world.ts);
 * below beta ≈ atan(0.8 / 1.7) ≈ 0.44 rad every ray through the middle of a townsperson misses: no speech cursor, and a
 * click on them gets no answer (only a click on their outer rim does).
 *
 * No product code is changed by this file.
 */
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REBASE_MIN_S,
  TownCrowd,
  newDrawn,
  stubCrowdAssets,
  type CrowdAgent,
  type CrowdAssets,
  type CrowdPose,
  type CrowdQuery,
  type CrowdSchedule,
} from '../src/town/crowd.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const EPOCH_2026 = 1_790_000_000

/** One townsperson standing still at the origin. */
class OneStanding implements CrowdSchedule {
  readonly agents: CrowdAgent[] = [{ id: 1, role: 'walker', female: false, rank: 0.5 }]
  pose(_i: number, q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    out.x = 0
    out.y = 0
    out.z = 0
    out.yaw = 0
    out.alpha = 1
    out.rate = 1
    out.clip = 'STAND1'
    out.clipT = q.nowS
    out.distM = Number.NaN
    out.speed = 0
    return true
  }
}

const query = (nowS: number): CrowdQuery => ({ nowS, solarT: 0.5, alarmFromS: 0, alarmUntilS: 0, rain: 0 })

function standing(): { crowd: TownCrowd; scene: Scene } {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const assets: CrowdAssets = stubCrowdAssets(scene)
  const crowd = new TownCrowd(assets, new OneStanding(), { kinds: ['folk'], variants: 10 })
  crowd.configure(60, 60)
  cleanups.push(() => {
    crowd.dispose()
    assets.dispose()
    scene.dispose()
    engine.dispose()
  })
  const threats = new Float32Array(2)
  for (let k = 0; k < 12; k++) {
    for (const v of assets.vats) v.manager.time = REBASE_MIN_S + k * 0.1
    crowd.update(query(EPOCH_2026 + k * 0.1), REBASE_MIN_S + k * 0.1, 0, 0, 0.1, threats, 0)
  }
  return { crowd, scene }
}

/** The world camera's view ray through a point of the townsperson (the camera's target), at pitch `beta`. */
function rayAt(scene: Scene, beta: number, aimY: number): { o: Vector3; d: Vector3 } {
  const cam = new ArcRotateCamera('cam', -Math.PI / 2, beta, 9, new Vector3(0, aimY, 0), scene)
  const o = cam.position.clone()
  const d = new Vector3(0, aimY, 0).subtract(o).normalize()
  return { o, d }
}

describe('H11-CH-2: the townsperson pick from a high camera', () => {
  it('the setup draws the townsperson (control)', () => {
    const { crowd } = standing()
    const d = newDrawn()
    expect(crowd.drawnOf(0, d)).toBe(true)
    expect(d.h).toBeGreaterThan(1.5)
  })

  it('at the default pitch (1.1 rad) a ray through the chest picks them (control)', () => {
    const { crowd, scene } = standing()
    const { o, d } = rayAt(scene, 1.1, 1.0)
    expect(crowd.pick(o.x, o.y, o.z, d.x, d.y, d.z, 400, 0, 0, 25).agent).toBe(0)
  })

  it('looking down (beta 0.3 rad, inside the camera limits 0.25–1.5) a ray through the chest still picks them', () => {
    const { crowd, scene } = standing()
    const { o, d } = rayAt(scene, 0.3, 1.0)
    // The ray goes through the body: it enters the 0.4 m capsule above the head and leaves it below the feet.
    expect(crowd.pick(o.x, o.y, o.z, d.x, d.y, d.z, 400, 0, 0, 25).agent).toBe(0)
  })
})
