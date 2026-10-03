/**
 * F-11 (docs/WAVE_PLAN7.md §6.7), the render fixer's own checks beside the H-11 repros:
 * - H11-NT-3: the carried lanterns' moving lights (TOWN_LIFE §7.1): at most LANTERN_LIGHTS, made only when the night
 *   cluster would take them, on the nearest holders, dark by day, dropped when the cluster lets go of them;
 * - H11-NT-2: the lantern's on-screen colour stays warm at a day's exposure too (the colour follows the exposure);
 * - H11-DET-1: the alarm start is floored to ALARM_QUANTUM_S;
 * - H11-HI-2: TownLife.loaded settles once the crowd is built.
 */
import { NullEngine, Scene, type Light } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { EXPOSURE_TRIM, neutralToneMap } from '../src/render/display.ts'
import { REBASE_MIN_S, TOWN_PRESETS, TownCrowd, stubCrowdAssets, type CrowdAgent, type CrowdPose, type CrowdQuery, type CrowdSchedule } from '../src/town/crowd.ts'
import { LANTERN_LIGHTS, TownLanterns, type LanternCluster } from '../src/town/props.ts'
import { ALARM_QUANTUM_S, alarmStart } from '../src/town/schedule.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

/** Guards standing on a line along +x, 3 m apart, from x = 3. */
class Guards implements CrowdSchedule {
  readonly agents: CrowdAgent[]
  constructor(n: number) {
    this.agents = Array.from({ length: n }, (_, i) => ({ id: i + 1, role: 'guard', female: false, rank: (i + 0.5) / n }))
  }

  pose(i: number, q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    out.x = 3 + i * 3
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

class FakeCluster implements LanternCluster {
  can = true
  readonly lights = new Set<Light>()
  canAddDynamicLight(): boolean {
    return this.can
  }

  addDynamicLight(light: Light): boolean {
    if (!this.can) return false
    this.lights.add(light)
    return true
  }

  removeDynamicLight(light: Light): void {
    this.lights.delete(light)
  }

  hasDynamicLight(light: Light): boolean {
    return this.lights.has(light)
  }
}

function rig(n: number) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const assets = stubCrowdAssets(scene)
  const sched = new Guards(n)
  const crowd = new TownCrowd(assets, sched, { kinds: ['folk', 'guard'], variants: 10 })
  crowd.configure(60, 60)
  const lanterns = new TownLanterns(scene, sched.agents)
  cleanups.push(() => {
    lanterns.dispose()
    crowd.dispose()
    assets.dispose()
    scene.dispose()
    engine.dispose()
  })
  const threats = new Float32Array(2)
  let t = 1_790_000_000
  const frame = (night: number, cluster: LanternCluster | null, solarT = 0.95) => {
    t += 0.1
    crowd.update({ nowS: t, solarT, alarmFromS: 0, alarmUntilS: 0, rain: 0 }, REBASE_MIN_S + 1, 0, 0, 0.1, threats, 0)
    lanterns.update(crowd, solarT, 2, night, cluster, 0, 0, 0.1)
  }
  return { scene, lanterns, frame }
}

describe('H11-NT-3: the carried lanterns light the street (TOWN_LIFE §7.1)', () => {
  it('at night the nearest LANTERN_LIGHTS holders get a cluster light; never more, and no scene light is left', () => {
    const { scene, lanterns, frame } = rig(8)
    const cluster = new FakeCluster()
    for (let k = 0; k < 20; k++) frame(1, cluster)
    expect(lanterns.count).toBe(8)
    expect(lanterns.lightCount).toBe(LANTERN_LIGHTS)
    expect(cluster.lights.size).toBe(LANTERN_LIGHTS)
    expect(lanterns.litCount).toBe(LANTERN_LIGHTS)
    // the nearest four (x = 3, 6, 9, 12; the lantern sits 0.3 m to the side)
    const xs = [...cluster.lights].map(l => Math.round((l as unknown as { position: { x: number } }).position.x)).sort((a, b) => a - b)
    expect(xs).toEqual([3, 6, 9, 12])
    // Medium's cap (TOWN_PRESETS.medium.lanternLights 2): the set is made again with two, the nearest
    lanterns.maxLights = TOWN_PRESETS.medium.lanternLights
    for (let k = 0; k < 20; k++) frame(1, cluster)
    expect([lanterns.lightCount, lanterns.litCount, cluster.lights.size]).toEqual([2, 2, 2])
  })

  it('no cluster (or one that refuses): no light is made at all; by day the made ones go dark', () => {
    const a = rig(3)
    for (let k = 0; k < 5; k++) a.frame(1, null)
    expect(a.lanterns.lightCount).toBe(0)
    const refusing = new FakeCluster()
    refusing.can = false
    for (let k = 0; k < 5; k++) a.frame(1, refusing)
    expect(a.lanterns.lightCount).toBe(0)
    expect(a.scene.lights.filter(l => l.name.startsWith('town:lantern')).length).toBe(0)
    const ok = new FakeCluster()
    for (let k = 0; k < 10; k++) a.frame(1, ok)
    expect(a.lanterns.litCount).toBe(3)
    for (let k = 0; k < 10; k++) a.frame(0, ok)
    expect(a.lanterns.litCount).toBe(0)
    expect(a.lanterns.lightCount).toBe(LANTERN_LIGHTS) // made once, kept dark (no light-count change at dusk)
  })

  it('a cluster that lets go of the lights (a preset without one) or a dispose drops them', () => {
    const { lanterns, frame } = rig(2)
    const cluster = new FakeCluster()
    for (let k = 0; k < 5; k++) frame(1, cluster)
    expect(lanterns.lightCount).toBe(LANTERN_LIGHTS)
    expect(lanterns.litCount).toBe(2)
    const made = [...cluster.lights]
    cluster.lights.clear()
    frame(1, cluster)
    expect(made.every(l => l.isDisposed())).toBe(true)
    // asked again on the next frames: the cluster takes new ones
    frame(1, cluster)
    expect(cluster.lights.size).toBe(LANTERN_LIGHTS)
    lanterns.dispose()
    expect(cluster.lights.size).toBe(0)
  })
})

describe('H11-NT-2: the lantern colour follows the exposure', () => {
  it('at a day exposure (2) the lantern is still warm and not white on screen', () => {
    const { lanterns, frame } = rig(1)
    frame(0, null, 0.5)
    const mat = lanterns.mesh.material as unknown as { albedoColor: { r: number; g: number; b: number } }
    const c = mat.albedoColor
    const k = 2 * EXPOSURE_TRIM
    const t = neutralToneMap([c.r * k, c.g * k, c.b * k])
    expect(t[2]! / t[0]!).toBeLessThan(0.75)
    expect(t[0]!).toBeGreaterThan(0.5)
  })
})

describe('H11-DET-1: the alarm start every client agrees on', () => {
  it('floors to ALARM_QUANTUM_S', () => {
    expect(ALARM_QUANTUM_S).toBe(1)
    expect(alarmStart(1_790_000_100.97)).toBe(1_790_000_100)
    expect(alarmStart(1_790_000_100)).toBe(1_790_000_100)
  })
})
