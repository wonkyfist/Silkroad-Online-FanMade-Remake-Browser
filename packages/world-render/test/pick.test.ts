/** Ray picking and walker height logic (pickNav, NavTrack) on a synthetic nav world; no Babylon. */
import { describe, expect, it } from 'vitest'
import { NavGltf, NavWorld, TERRAIN_SURFACE, buildNavData, type NavMeshInput, type NvmInput } from '@sro/nav'
import { flatRegion, grid, mesh, placement, REGION_ID, RX, RZ } from '../../nav/test/synthetic.ts'
import { NavTrack, pickNav } from '../src/index.ts'

type Obj = { nav: NavMeshInput; x: number; y: number; z: number }

/** A 100 x 100 unit (10 m) square navmesh centred on its origin, all outline edges `flag`. */
const square = (flag: number): NavMeshInput => {
  const g = grid(-50, 50, -50, 50, 2, 2)
  return mesh(g.vertices, g.triangles, () => flag).nav
}

/**
 * Region (RX, RZ), flat terrain at 0, glTF origin at its south-west corner: glTF (x, z) = 0.1 (lx, -lz).
 *   0: platform 1 m above the terrain at local (500, 500), open outline (walk on / off)
 *   1: walkway 20 m up at (1000, 500), outline flag 16 (underpass: terrain walkers pass beneath)
 *   2: solid block at (1500, 500), outline flag 3
 */
function testWorld(): NavGltf {
  const objects: Obj[] = [
    { nav: square(0), x: 500, y: 10, z: 500 },
    { nav: square(16), x: 1000, y: 200, z: 500 },
    { nav: square(3), x: 1500, y: 0, z: 500 },
  ]
  const nvm: NvmInput = { ...flatRegion(), objects: objects.map((o, i) => placement(i, i + 1, o.x, o.y, o.z)) }
  const data = buildNavData({ regions: [{ id: REGION_ID, nvm }], objectNavMesh: id => ({ key: `m${id}`, navMesh: objects[id]!.nav }) })
  return new NavGltf(new NavWorld(data), { x: RX, z: RZ })
}

const nav = testWorld()
/** glTF metres of region-local file units. */
const gx = (lx: number) => lx * 0.1
const gz = (lz: number) => -lz * 0.1

/** A ray from `from` toward `to` (glTF). */
function ray(from: [number, number, number], to: [number, number, number]) {
  return [from[0], from[1], from[2], to[0] - from[0], to[1] - from[1], to[2] - from[2]] as const
}

describe('pickNav', () => {
  it('hits the platform floor from above, not the terrain under it', () => {
    const hit = pickNav(nav, ...ray([gx(470), 8, gz(470)], [gx(500), 1, gz(500)]))!
    expect(hit.surface).toMatchObject({ kind: 'object', instance: 0 })
    expect(hit.y).toBeCloseTo(1, 6)
    expect(hit.x).toBeCloseTo(gx(500), 3)
    expect(hit.z).toBeCloseTo(gz(500), 3)
    expect(hit.walkable).toBe(true)
  })

  it('hits the terrain next to the platform', () => {
    const hit = pickNav(nav, ...ray([gx(300), 10, gz(300)], [gx(400), 0, gz(400)]))!
    expect(hit.surface).toBe(TERRAIN_SURFACE)
    expect(hit.y).toBeCloseTo(0, 6)
    expect(hit.x).toBeCloseTo(gx(400), 3)
  })

  it('does not hit a walkway from beneath: the ray passes under it to the ground', () => {
    // Enters the walkway's footprint (950..1050) at ~5 m, far below its 20 m deck, and lands at local x 1100.
    const hit = pickNav(nav, ...ray([gx(900), 6, gz(500)], [gx(1100), 0, gz(500)]))!
    expect(hit.surface).toBe(TERRAIN_SURFACE)
    expect(hit.x).toBeCloseTo(gx(1100), 3)
  })

  it('hits the walkway deck from above', () => {
    const hit = pickNav(nav, ...ray([gx(900), 30, gz(500)], [gx(1000), 20, gz(500)]))!
    expect(hit.surface).toMatchObject({ kind: 'object', instance: 1 })
    expect(hit.y).toBeCloseTo(20, 6)
  })

  it('takes long rays in few steps and still finds a shallow hit far away', () => {
    // A 150 m ray at a grazing angle: adaptive steps must not overshoot the ground.
    const hit = pickNav(nav, ...ray([gx(100), 3, gz(100)], [gx(1600), 0, gz(1600)]), 600)!
    expect(hit.surface.kind).toBe('terrain')
    expect(hit.x).toBeCloseTo(gx(1600), 2)
  })

  it('returns null for a ray pointing at the sky', () => {
    expect(pickNav(nav, ...ray([gx(500), 5, gz(500)], [gx(600), 50, gz(600)]))).toBeNull()
  })
})

describe('NavTrack', () => {
  it('places on the surface nearest the hint', () => {
    const t = new NavTrack(nav, gx(500), gz(500), 0.9)
    expect(t.pos.surface).toMatchObject({ kind: 'object', instance: 0 })
    expect(t.place(gx(500), gz(500), 0.2).surface).toBe(TERRAIN_SURFACE)
    expect(t.place(gx(500), gz(500)).y).toBeCloseTo(1, 6) // default: the highest
  })

  it('walks over the platform: height from each leg surface along the chord', () => {
    const t = new NavTrack(nav, gx(300), gz(500), 0)
    const r = t.begin(gx(300), gz(500), gx(700), gz(500))
    expect(r.blocked).toBe(false)
    const at = (lx: number) => t.heightAt(gx(lx), gz(500))
    expect(at(400)).toBeCloseTo(0, 6)
    expect(at(500)).toBeCloseTo(1, 6)
    expect(t.pos.surface).toMatchObject({ kind: 'object', instance: 0 })
    expect(at(540)).toBeCloseTo(1, 6)
    expect(at(600)).toBeCloseTo(0, 6)
    expect(at(700)).toBeCloseTo(0, 6)
    expect(t.move).toBeNull()
    expect(t.pos.surface).toBe(TERRAIN_SURFACE)
  })

  it('walks under the walkway on the terrain (never snaps up to the deck)', () => {
    const t = new NavTrack(nav, gx(900), gz(500), 0)
    t.begin(gx(900), gz(500), gx(1100), gz(500))
    expect(t.heightAt(gx(1000), gz(500))).toBeCloseTo(0, 6)
    expect(t.pos.surface).toBe(TERRAIN_SURFACE)
  })

  it('stops at a blocking edge: the move end is short of the click', () => {
    const t = new NavTrack(nav, gx(1300), gz(500), 0)
    const r = t.begin(gx(1300), gz(500), gx(1500), gz(500))
    expect(r.blocked).toBe(true)
    expect(r.end.x).toBeLessThan(gx(1451))
    expect(r.end.x).toBeGreaterThan(gx(1440))
  })

  it('stands still on the retained surface (settle) and keeps the deck over the terrain', () => {
    const t = new NavTrack(nav, gx(500), gz(500), 1)
    expect(t.heightAt(gx(510), gz(505))).toBeCloseTo(1, 6)
    expect(t.pos.surface.kind).toBe('object')
    t.settle(gx(520), gz(500))
    expect(t.pos.y).toBeCloseTo(1, 6)
  })
})
