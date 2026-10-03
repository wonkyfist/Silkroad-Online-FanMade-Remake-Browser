/**
 * The retail target circle and the click marker (docs/EFFECTS.md §3.13, docs/WAVE_PLAN2.md §5.11): the tone ->
 * select_0N mapping, the radius rule, the conforming disc (heights follow the ground, a ledge stays flat), the spin in
 * the UVs, and the click marker's shrink and fade. NullEngine; empty textures (no fetch).
 */
import { NullEngine, Scene, Texture } from '@babylonjs/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ClickMarker,
  DECAL_RINGS,
  DECAL_SEGS,
  DECAL_TEXTURE,
  decalGrid,
  decalHeights,
  decalRadius,
  decalUvs,
  MARKER_LIFE,
  MARKER_RADIUS,
  markerFrame,
  selectTextureUrl,
  TargetDecal,
  type DecalTextureSource,
  type SelectTexture,
} from '../src/world/effects.ts'

let engine: NullEngine
let scene: Scene
const loaded: SelectTexture[] = []
const source: DecalTextureSource = (key, s) => {
  loaded.push(key)
  return new Texture(null, s)
}

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})

afterAll(() => {
  scene.dispose()
  engine.dispose()
})

describe('target circle rules', () => {
  it('maps tones to the retail select textures', () => {
    expect(DECAL_TEXTURE).toEqual({ hostile: 'select_04', neutral: 'select_02', friendly: 'select_03', item: 'select_01' })
    expect(selectTextureUrl('select_04')).toBe('/out/fx/tex/ui/select_04.png')
  })

  it('puts the ink edge 0.25 m outside the body, with a floor for tiny targets', () => {
    expect(decalRadius(1)).toBeCloseTo(1.25)
    expect(decalRadius(0.1)).toBeCloseTo(0.6)
  })

  it('builds a closed disc: a centre fan and quads between the rings', () => {
    const { xz, indices } = decalGrid()
    expect(xz.length / 2).toBe(1 + DECAL_RINGS * DECAL_SEGS)
    expect(indices.length).toBe(3 * (DECAL_SEGS + 2 * DECAL_SEGS * (DECAL_RINGS - 1)))
    expect(Math.max(...indices)).toBe(xz.length / 2 - 1)
    for (let i = 2; i < xz.length; i += 2) expect(Math.hypot(xz[i]!, xz[i + 1]!)).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('turns the art in the UVs and keeps it inside the texture', () => {
    const xz = [0, 0, 1, 0]
    const still = decalUvs(xz, 0)
    expect(still[0]).toBeCloseTo(0.5)
    expect(still[2]).toBeGreaterThan(0.9)
    expect(still[2]).toBeLessThanOrEqual(1)
    const turned = decalUvs(xz, Math.PI / 2)
    expect(turned[2]).toBeCloseTo(0.5)
    expect(turned[3]).toBeCloseTo(still[2]!)
  })

  it('follows the ground and stays flat over a ledge', () => {
    const { xz } = decalGrid()
    const slope = (x: number) => x * 0.5
    const h = decalHeights(xz, 0, 0, 0, 1, x => slope(x))
    // The rim point at +x is 0.5 m higher than the centre, the one at -x 0.5 m lower (plus the lift).
    const east = 1 + (DECAL_RINGS - 1) * DECAL_SEGS
    const west = east + DECAL_SEGS / 2
    expect(h[east]! - h[0]!).toBeCloseTo(0.5)
    expect(h[west]! - h[0]!).toBeCloseTo(-0.5)
    const cliff = decalHeights(xz, 0, 10, 0, 1, x => (x > 0.5 ? 30 : 10))
    expect(cliff[east]).toBeCloseTo(cliff[0]!)
    const flat = decalHeights(xz, 0, 5, 0, 1)
    expect(new Set(flat.map(v => v.toFixed(4))).size).toBe(1)
  })

  it('shrinks and fades the click marker over its life', () => {
    expect(markerFrame(0)).toEqual({ scale: 1, alpha: 1 })
    const mid = markerFrame(MARKER_LIFE / 2)
    const end = markerFrame(MARKER_LIFE)
    expect(mid.scale).toBeLessThan(1)
    expect(end.scale).toBeLessThan(mid.scale)
    expect(mid.alpha).toBeLessThan(1)
    expect(end.alpha).toBeCloseTo(0)
  })
})

describe('TargetDecal (same API as TargetRing)', () => {
  it('shows, follows, turns, hides and disposes', () => {
    const decal = new TargetDecal(scene, (x, _z, nearY) => nearY + (x - 10) * 0.25, source)
    expect(decal.visible).toBe(false)
    decal.show('hostile', 0.8)
    expect(decal.visible).toBe(true)
    expect(decal.state).toEqual({ texture: 'select_04', radius: decalRadius(0.8) })
    expect(loaded).toContain('select_04')
    decal.update(0.016, 10, 2, -4)
    expect(decal.mesh.position.asArray()).toEqual([10, 2, -4])
    // The rim point at +x sits higher than the one at -x (the sampler slopes up along x).
    const east = 1 + (DECAL_RINGS - 1) * DECAL_SEGS
    expect(decal.heightOf(east)).toBeGreaterThan(decal.heightOf(east + DECAL_SEGS / 2))
    decal.show('neutral', 0.5)
    expect(decal.state.texture).toBe('select_02')
    decal.hide()
    expect(decal.visible).toBe(false)
    decal.update(1, 0, 0, 0)
    expect(decal.mesh.position.x).toBe(10)
    decal.dispose()
    expect(scene.getMeshByName('targetDecal')).toBeNull()
  })
})

describe('ClickMarker', () => {
  it('appears where clicked, shrinks, fades and hides itself', () => {
    const marker = new ClickMarker(scene, undefined, source)
    expect(loaded).toContain('select_02')
    expect(marker.visible).toBe(false)
    marker.show(3, 1, 7)
    expect(marker.visible).toBe(true)
    expect(marker.mesh.position.asArray()).toEqual([3, 1, 7])
    const rim = () => {
      const pos = marker.mesh.getVerticesData('position')!
      const i = 1 + (DECAL_RINGS - 1) * DECAL_SEGS
      return Math.hypot(pos[i * 3]!, pos[i * 3 + 2]!)
    }
    expect(rim()).toBeCloseTo(MARKER_RADIUS)
    marker.update(MARKER_LIFE / 2)
    expect(rim()).toBeLessThan(MARKER_RADIUS)
    expect(marker.alpha).toBeLessThan(1)
    marker.update(MARKER_LIFE)
    expect(marker.visible).toBe(false)
    marker.show(0, 0, 0)
    marker.hide()
    expect(marker.visible).toBe(false)
    marker.dispose()
  })
})
