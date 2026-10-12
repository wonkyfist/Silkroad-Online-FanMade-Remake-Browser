// The rare weapon's own light (world/rarity/fx.ts GLOW_LIGHT): it joined the night lights' cluster and lit the floor in
// an orange pool, and washed the wearer at the crit flash's full strength. A pool with `cluster: false` never joins
// (its layer mask keeps the ground out), and takes its own short range and low peak.
import { NullEngine, PointLight, Scene, type Light } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { HitLights, setHitLightCluster } from '../src/world/fx/hit-light.ts'

afterEach(() => setHitLightCluster(null))

describe('rare weapon glow light', () => {
  it('never joins the cluster, short and dim; the crit flashes still join', () => {
    const scene = new Scene(new NullEngine())
    const joined: Light[] = []
    setHitLightCluster({ addDynamicLight: l => (joined.push(l), true) })
    let t = 0
    const glow = new HitLights(scene, () => t, 1, { range: 1.6, peak: 0.45, cluster: false })
    const flashes = new HitLights(scene, () => t, 2)
    glow.joinCluster(t, true)
    flashes.joinCluster(t, true)
    expect(joined.length).toBe(2)
    const light = scene.lights.find(l => l.name === 'fx:hitlight0' && !joined.includes(l)) as PointLight
    expect(light.range).toBeCloseTo(1.6)
    glow.flash([0, 1, 0], [1, 0.5, 0.2], 420)
    expect(light.intensity).toBeCloseTo(0.45)
    t = 100
    glow.update()
    expect(light.intensity).toBeLessThan(0.45)
    expect(joined).not.toContain(light)
    scene.getEngine().dispose()
  })
})
