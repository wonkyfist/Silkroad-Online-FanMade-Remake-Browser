/**
 * Minimap tile mode (docs/FIELDS.md §5.2): render() draws the region tiles under the view at their region position
 * (the same toPx rule as the atlas) and fills missing ones with #202225. A recording 2D context stands in for the
 * browser canvas.
 */
import { describe, expect, it } from 'vitest'
import { MINIMAP_FILL, Minimap, minimapFill, type MinimapTile } from '../src/index.ts'
import { OPEN_SEA_TONE as CONVERT_OPEN_SEA_TONE, seaColour, type CoastMapColours } from '../../convert/src/world/coast/minimap.ts'
import { CX, CZ, N, X0, makeFixture } from './stream-fixture.ts'

function recorder() {
  const ops: Array<{ op: string; args: unknown[]; fill?: string }> = []
  let fillStyle = ''
  const ctx = new Proxy({}, {
    get(_t, key: string) {
      if (key === 'fillStyle') return fillStyle
      return (...args: unknown[]) => ops.push({ op: key, args, fill: fillStyle })
    },
    set(_t, key: string, value) {
      if (key === 'fillStyle') fillStyle = String(value)
      return true
    },
  })
  const canvas = { width: 168, height: 168, getContext: () => ctx } as unknown as HTMLCanvasElement
  return { ops, canvas }
}

describe('Minimap tile mode', () => {
  it('draws the tiles under the view and fills missing regions', () => {
    const { manifest } = makeFixture()
    const { ops, canvas } = recorder()
    const map = new Minimap(canvas, manifest, { tiles: true })
    expect(map.tileMode).toBe(true)
    const tile = { close: () => { closed++ } } as unknown as MinimapTile
    let closed = 0
    map.setTile(CX, CZ, tile)
    expect(map.tileCount).toBe(1)
    // Centre of the origin region: the view (168 px at scale 1 = 126 m) lies inside that one tile.
    map.render({ x: 96, z: -96, heading: 0 }, { scale: 1 })
    const draws = ops.filter(o => o.op === 'drawImage')
    expect(draws).toHaveLength(1)
    expect(draws[0]!.args[0]).toBe(tile)
    // Tile position relative to the player's atlas pixel: the region's NW corner is 96 m / 0.75 = 128 px up-left.
    expect(draws[0]!.args[1]).toBeCloseTo(-128, 6)
    expect(draws[0]!.args[2]).toBeCloseTo(-128, 6)
    // At the region's east border the neighbour (not loaded) is filled.
    ops.length = 0
    map.render({ x: 190, z: -96, heading: 0 }, { scale: 1 })
    expect(ops.filter(o => o.op === 'drawImage')).toHaveLength(1)
    expect(ops.some(o => o.op === 'fillRect' && o.fill === '#202225')).toBe(true)
    map.removeTile(CX, CZ)
    expect(closed).toBe(1)
    expect(map.tileCount).toBe(0)
  })

  it('fills the sea beyond the coast in mapColor, a pending known tile in #202225 (docs/COAST.md §11)', () => {
    const { manifest } = makeFixture()
    expect(minimapFill(manifest)).toBe(MINIMAP_FILL)
    expect(minimapFill({ coast: { mapColor: 'blue' } })).toBe(MINIMAP_FILL)
    const coastal = { ...manifest, coast: { mapColor: '#2a5d7c' }, regions: manifest.regions.map(r => ({ ...r, minimap: `minimap/${r.x}x${r.z}.png` })) }
    const { ops, canvas } = recorder()
    const map = new Minimap(canvas, coastal as typeof manifest, { tiles: true })
    // mapColor x 0.75: the deep-water colour the converter's tiles reach (and its world-map fill).
    expect(map.fill).toBe('#20465d')
    expect(CONVERT_OPEN_SEA_TONE).toBe(0.75)
    const deep: number[] = []
    seaColour({ sea: [0x2a, 0x5d, 0x7c], shallow: [84, 141, 137] } as unknown as CoastMapColours, 60, deep)
    expect('#' + deep.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')).toBe(map.fill)
    map.setTile(CX, CZ, {} as MinimapTile)
    // The origin region's east neighbour is in the manifest but not loaded: the dark pending fill, not sea.
    // (tile fills are 256 px squares; the canvas background under them is a separate fillRect.)
    const tileFills = () => ops.filter(o => o.op === 'fillRect' && o.args[2] === 256).map(o => o.fill)
    map.render({ x: 190, z: -96, heading: 0 }, { scale: 1 })
    expect(tileFills()).toContain(MINIMAP_FILL)
    expect(tileFills()).not.toContain('#20465d')
    // Past the east edge of the export (no region there): the sea.
    ops.length = 0
    const eastEdge = (X0 + N - CX) * 192
    map.render({ x: eastEdge - 10, z: -96, heading: 0 }, { scale: 1 })
    expect(tileFills()).toContain('#20465d')
  })
})
