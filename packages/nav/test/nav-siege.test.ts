/**
 * Siege of Jangan (docs/SIEGE.md §4.1, §14): the two runtime seams of NavWorld that let a wall third fall.
 * - setInstanceEnabled: a disabled solid stops blocking walkers, stops being located, and its outline leaves the
 *   walkable components; switching it back restores everything;
 * - setTileOverride: a forced-open closed tile walks like an open one, a forced-closed one blocks; overrides survive
 *   region streaming and apply only while the region is loaded;
 * - the components (reach) are rebuilt after each switch.
 */
import { describe, expect, it } from 'vitest'
import { NVM_TILE_SIZE, NVM_TILES } from '@sro/formats'
import { NavWorld, buildNavData, type NavData, type NavMeshInput, type NavPosition } from '../src/index.ts'
import { OX, OZ, REGION_ID, flatRegion, grid, mesh, placement } from './synthetic.ts'

/** A wall slab 600 x 60 units (local -300..300 x -30..30), outline flag 3: a solid nobody walks onto. */
function slab(): NavMeshInput {
  const g = grid(-300, 300, -30, 30, 6, 1, () => 200)
  return mesh(g.vertices, g.triangles, () => 3).nav
}

/** Region with the slab at (960, 960) and, optionally, a closed band of tiles along z under it (a ditch rim). */
function data(closedBand: boolean): NavData {
  const band = (tx: number, tz: number) => closedBand && tz === 48 && tx >= 40 && tx < 56
  const nvm = { ...flatRegion(0, band), objects: [placement(0, 0x8001, 960, 0, 960)] }
  return buildNavData({ regions: [{ id: REGION_ID, nvm }], objectNavMesh: () => ({ key: 'slab', navMesh: slab() }) })
}

const ground = (x: number, z: number): NavPosition => ({ x: OX + x, y: 0, z: OZ + z, surface: { kind: 'terrain' } })
const walk = (w: NavWorld, x0: number, z0: number, x1: number, z1: number) => w.moveStraight(ground(x0, z0), OX + x1, OZ + z1)
const tileOf = (x: number, z: number) => Math.floor(z / NVM_TILE_SIZE) * NVM_TILES + Math.floor(x / NVM_TILE_SIZE)

describe('NavWorld.setInstanceEnabled (a wall third that falls)', () => {
  it('a disabled solid stops blocking and covering; enabling it again restores the wall', () => {
    const w = new NavWorld(data(false))
    expect(walk(w, 960, 800, 960, 1100).blocked).toBe(true)
    // the slab's top is a surface (locate finds it above the terrain)
    expect(w.locate(OX + 960, OZ + 960, Infinity)!.surface.kind).toBe('object')
    const inside = w.componentOf(ground(960, 800))
    expect(w.componentOf(ground(960, 1100))).toBe(inside)

    expect(w.setInstanceEnabled(0, false)).toBe(true)
    expect(w.setInstanceEnabled(0, false)).toBe(false)
    expect(w.isInstanceEnabled(0)).toBe(false)
    const through = walk(w, 960, 800, 960, 1100)
    expect(through.blocked).toBe(false)
    expect(through.legs.every(l => l.surface.kind === 'terrain')).toBe(true)
    expect(w.locate(OX + 960, OZ + 960, Infinity)!.surface.kind).toBe('terrain')
    expect(w.debugEdges(OX, OZ, OX + 1920, OZ + 1920)).toEqual([])
    expect(w.runtimeSwitches.disabled).toBe(1)

    w.setInstanceEnabled(0, true)
    expect(walk(w, 960, 800, 960, 1100).blocked).toBe(true)
    expect(w.runtimeSwitches.disabled).toBe(0)
  })

  it('the components follow the switch: the terrain under the slab joins the field only while it is down', () => {
    const w = new NavWorld(data(false))
    const under = ground(960, 960)
    const field = w.componentOf(ground(960, 1500))
    // under a solid footprint the terrain walks out but nobody walks in
    expect(w.componentOf(under)).not.toBe(field)
    w.setInstanceEnabled(0, false)
    expect(w.componentOf(under)).toBe(w.componentOf(ground(960, 1500)))
    w.setInstanceEnabled(0, true)
    expect(w.componentOf(under)).not.toBe(w.componentOf(ground(960, 1500)))
  })

  it('a disabled index keeps its state across editInstances (remapped) and refuses unknown indices', () => {
    const w = new NavWorld(data(false))
    w.setInstanceEnabled(0, false)
    w.editInstances({ put: [{ id: 0xabcdf001, objId: 1, model: 0, x: OX + 300, y: 0, z: OZ + 300, yaw: 0 }] })
    expect(w.isInstanceEnabled(0)).toBe(false)
    expect(w.isInstanceEnabled(1)).toBe(true)
    expect(() => w.setInstanceEnabled(7, false)).toThrow(/no instance/)
  })
})

describe('NavWorld.setTileOverride (the breach tiles)', () => {
  it('forced open walks across a closed rim; forced closed blocks; null restores the region', () => {
    const w = new NavWorld(data(true))
    w.setInstanceEnabled(0, false)
    // the closed band at tz 48 (z 960..980) still stops the walk
    expect(walk(w, 960, 800, 960, 1100).hit?.kind).toBe('tile')
    for (let tx = 40; tx < 56; tx++) expect(w.setTileOverride(REGION_ID, 48 * NVM_TILES + tx, 'open')).toBe(true)
    expect(w.tileOverride(REGION_ID, tileOf(960, 970))).toBe('open')
    expect(w.terrainOpen(OX + 960, OZ + 970)).toBe(true)
    expect(walk(w, 960, 800, 960, 1100).blocked).toBe(false)
    expect(w.componentOf(ground(960, 800))).toBe(w.componentOf(ground(960, 1100)))
    expect(w.runtimeSwitches.tiles).toBe(16)

    w.setTileOverride(REGION_ID, tileOf(1500, 1500), 'closed')
    expect(w.terrainOpen(OX + 1500, OZ + 1500)).toBe(false)
    expect(walk(w, 1500, 1300, 1500, 1700).hit?.kind).toBe('tile')
    expect(w.setTileOverride(REGION_ID, tileOf(1500, 1500), null)).toBe(true)
    expect(w.setTileOverride(REGION_ID, tileOf(1500, 1500), null)).toBe(false)
    expect(w.terrainOpen(OX + 1500, OZ + 1500)).toBe(true)
    expect(() => w.setTileOverride(REGION_ID, NVM_TILES * NVM_TILES, 'open')).toThrow(/bad tile/)
  })

  it('an override is kept while its region streams out and applies again when it streams back in', () => {
    const d = data(true)
    const w = new NavWorld({ ...d, regions: [] })
    w.setTileOverride(REGION_ID, tileOf(960, 970), 'open')
    expect(w.terrainOpen(OX + 960, OZ + 970)).toBe(false)
    w.addRegion(d.regions[0]!)
    expect(w.terrainOpen(OX + 960, OZ + 970)).toBe(true)
    expect(w.terrainOpen(OX + 1000, OZ + 970)).toBe(false)
    w.removeRegion(REGION_ID)
    expect(w.terrainOpen(OX + 960, OZ + 970)).toBe(false)
  })
})
