/**
 * Siege of Jangan polish (docs/SIEGE.md, layer 4 status): the panel's folded clock and the quest tracker's shift under
 * it, where the Warlord is, his look (dark, gold-edged, bigger than his army) and his gear (beacon fade, the PBR path's
 * linear texels, nothing left behind after dispose).
 */
import { NullEngine, Scene, TransformNode } from '@babylonjs/core'
import { SIEGE_EVENT_CODES, SIEGE_MOBS, type SiegeView } from '@sro/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { en } from '../src/i18n/en.ts'
import { siegeClock, trackerShift, warlordWhere } from '../src/world/siege/model.ts'
import { BEACON_FADE, beaconAlpha, buildWarlordGear, linearByte, WARLORD_LOOK } from '../src/world/siege/warlord.ts'

const NOW = 1_000_000

describe('the siege panel', () => {
  const v = (o: Partial<SiegeView>): SiegeView => ({ id: 1, phase: 'warning', approaches: ['W'], ...o })

  it('the folded clock: to the army, the next wave, the end; none after it', () => {
    expect(siegeClock(v({ nextAt: NOW + 4 * 60_000 + 30_000 }), NOW)).toBe('4:30')
    expect(siegeClock(v({ phase: 'wave2', nextAt: NOW + 61_000 }), NOW)).toBe('1:01')
    expect(siegeClock(v({ phase: 'wave3', endsAt: NOW + 90_000 }), NOW)).toBe('1:30')
    expect(siegeClock(v({ phase: 'wave3' }), NOW)).toBeNull()
    expect(siegeClock(v({ phase: 'ended', endsAt: NOW + 5000 }), NOW)).toBeNull()
  })

  it('the quest tracker moves down only as far as the panel reaches into it', () => {
    expect(trackerShift(324, 200)).toBe(132)
    expect(trackerShift(250, 262)).toBe(0)
    expect(trackerShift(255, 262)).toBe(1)
    expect(trackerShift(300, 200, 0)).toBe(100)
    expect(trackerShift(Number.NaN, 200)).toBe(0)
  })

  it('where the Warlord is: metres and the compass word (north is −Z)', () => {
    expect(warlordWhere(0, -40)).toBe('He is 40 m to the north')
    expect(warlordWhere(30, 30)).toBe('He is 42 m to the south-east')
    expect(warlordWhere(-20, 0)).toBe('He is 20 m to the west')
    expect(warlordWhere(2, -3)).toBe('He is right here!')
  })

  it('every new string exists', () => {
    const e = en as Record<string, string>
    for (const k of ['siege.label.warlord', 'siege.hud.fold', 'siege.hud.unfold', 'siege.where.far', 'siege.where.here']) expect(e[k], k).toBeTruthy()
  })
})

describe('the Bandit Warlord', () => {
  it('towers over his army', () => {
    const lord = SIEGE_MOBS.find((m) => m.code === SIEGE_EVENT_CODES.warlord)!
    const others = SIEGE_MOBS.filter((m) => m.code !== SIEGE_EVENT_CODES.warlord)
    expect(lord.scale).toBeGreaterThanOrEqual(200)
    for (const m of others) expect(lord.scale).toBeGreaterThan(m.scale)
  })

  it('wears dark crimson with a gold edge', () => {
    const [r, g, b] = WARLORD_LOOK.light
    expect(r).toBeGreaterThan(4 * g)
    expect(r).toBeGreaterThan(4 * b)
    expect(Math.max(...WARLORD_LOOK.dark)).toBeLessThan(0.02)
    expect(WARLORD_LOOK.rim[0]).toBeGreaterThan(WARLORD_LOOK.rim[2])
    expect(WARLORD_LOOK.rimGain).toBeGreaterThan(0)
  })

  it('the beacon fades in with distance and never goes opaque', () => {
    const [near, far] = BEACON_FADE
    expect(beaconAlpha(near - 5)).toBe(0)
    expect(beaconAlpha(near)).toBe(0)
    expect(beaconAlpha((near + far) / 2)).toBeGreaterThan(0)
    expect(beaconAlpha(far)).toBe(beaconAlpha(far + 100))
    expect(beaconAlpha(far + 100)).toBeLessThanOrEqual(0.5)
  })

  it('linear texels for the PBR path: the ends stay, the middle darkens', () => {
    expect(linearByte(0)).toBe(0)
    expect(linearByte(255)).toBe(255)
    expect(linearByte(128)).toBe(55)
    expect(linearByte(10)).toBeLessThan(10)
  })
})

describe('the Warlord gear', () => {
  let engine: NullEngine
  let scene: Scene
  beforeEach(() => {
    engine = new NullEngine()
    scene = new Scene(engine)
  })
  afterEach(() => {
    scene.dispose()
    engine.dispose()
  })

  for (const path of ['classic', 'pbr'] as const) {
    it(`builds, hides when dead and leaves nothing behind (${path})`, () => {
      const body = new TransformNode('body', scene)
      const ground = new TransformNode('ground', scene)
      const meshes = scene.meshes.length
      const nodes = scene.transformNodes.length
      const materials = scene.materials.length
      const gear = buildWarlordGear(scene, 'lord', body, ground, path, (x) => x * 0.1)
      expect(scene.meshes.length).toBe(meshes + 5)
      expect(scene.meshes.slice(meshes).every((m) => !m.isPickable)).toBe(true)
      gear.update(1, 0.016, 40, true)
      const beacon = scene.meshes.find((m) => m.name === 'lordBeacon')!
      expect(beacon.visibility).toBeCloseTo(beaconAlpha(40))
      const ring = scene.meshes.find((m) => m.name === 'lordRing')!
      // a 10 % east-up slope tilts the ring about Z
      expect((ring.parent as TransformNode).rotation.z).toBeCloseTo(Math.atan(0.1))
      gear.update(2, 0.016, 40, false)
      expect(ring.isEnabled()).toBe(false)
      gear.dispose()
      expect(scene.meshes.length).toBe(meshes)
      expect(scene.transformNodes.length).toBe(nodes)
      // the materials are shared per scene and path: a second Warlord makes none
      const once = scene.materials.length
      expect(once).toBeGreaterThan(materials)
      buildWarlordGear(scene, 'lord2', body, ground, path).dispose()
      expect(scene.materials.length).toBe(once)
    })
  }
})
