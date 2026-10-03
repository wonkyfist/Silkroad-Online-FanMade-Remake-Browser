/**
 * Walker heights and picks on the real Jangan navmeshes (work/out/world/jangan/nav.bin; skipped without it), against
 * the walks of docs/NAVIGATION.md §8. Region-local file units of 168x97 (the origin region) map to glTF metres as
 * (0.1 lx, -0.1 lz).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NavGltf, NavWorld, decodeNavData } from '@sro/nav'
import { describe, expect, it } from 'vitest'
import { NavTrack, pickNav } from '../src/index.ts'

const FILE = join(fileURLToPath(new URL('../../../', import.meta.url)), 'work', 'out', 'world', 'jangan', 'nav.bin')
const gx = (lx: number) => lx * 0.1
const gz = (lz: number) => -lz * 0.1

describe.skipIf(!existsSync(FILE))('Jangan navmesh (nav.bin)', () => {
  const nav = new NavGltf(new NavWorld(decodeNavData(new Uint8Array(readFileSync(FILE)))), { x: 168, z: 97 })

  it('walks from the street onto the plaza and stays on the deck above the sunken terrain', () => {
    const t = new NavTrack(nav, gx(1300), gz(450), 0)
    expect(t.pos.surface.kind).toBe('terrain')
    const r = t.begin(gx(1300), gz(450), gx(1008.4), gz(715))
    expect(r.blocked).toBe(false)
    // Sample the chord like the per-frame update does.
    const n = 40
    let onDeck = 0
    for (let i = 0; i <= n; i++) {
      const x = r.legs[0]!.x0 + ((gx(1008.4) - r.legs[0]!.x0) * i) / n
      const z = r.legs[0]!.z0 + ((gz(715) - r.legs[0]!.z0) * i) / n
      const y = t.heightAt(x, z)
      if (t.pos.surface.kind === 'object') {
        onDeck++
        expect(y).toBeGreaterThan(-3.4)
      }
    }
    expect(onDeck).toBeGreaterThan(5)
    expect(t.pos.surface.kind).toBe('object')
    expect(t.pos.y).toBeCloseTo(-3.261, 2)
    // The terrain under the arrival point is ~1.5 m lower: a terrain-only height would sink the player.
    expect(nav.world.terrainHeight(nav.fileX(gx(1008.4)), nav.fileZ(gz(715))) * 0.1).toBeCloseTo(-4.791, 2)
  })

  it('stops at the fountain terrace (blocked) as NAVIGATION.md §8 walks it', () => {
    const t = new NavTrack(nav, gx(1008.4), gz(715), -3.3)
    const r = t.begin(gx(1008.4), gz(715), gx(979), gz(856))
    expect(r.blocked).toBe(true)
    expect(r.end.x).toBeCloseTo(gx(999.6), 1)
    expect(r.end.z).toBeCloseTo(gz(757.3), 1)
    expect(r.end.y).toBeCloseTo(-3.261, 2)
  })

  it('picks the plaza deck (not the terrain below) with a steep camera ray', () => {
    const tx = gx(1008.4), tz = gz(715)
    const hit = pickNav(nav, tx + 4, 6, tz + 7, -4, -6 - 3.261, -7)!
    expect(hit.surface.kind).toBe('object')
    expect(hit.walkable).toBe(true)
    expect(hit.y).toBeCloseTo(-3.261, 2)
    expect(Math.hypot(hit.x - tx, hit.z - tz)).toBeLessThan(0.05)
  })

  it("resyncs a stale retained surface from the server's y (terrain under the plaza -> the plaza deck)", () => {
    const x = gx(1008.4), z = gz(715)
    // A walker wrongly kept on the sunken terrain (a missed message, a background tab that drew no frames).
    const t = new NavTrack(nav, x, z, -4.8)
    expect(t.pos.surface.kind).toBe('terrain')
    // Without the server's y the retained surface stays; with it (the plaza, 1.5 m higher) the deck is taken.
    expect(t.settle(x, z).surface.kind).toBe('terrain')
    expect(t.settle(x, z, -3.261).surface.kind).toBe('object')
    expect(t.pos.y).toBeCloseTo(-3.261, 2)
    // begin() does the same with the move's start y: the walk to the fountain then stops at the terrace as usual.
    t.place(x, z, -4.8)
    const r = t.begin(x, z, gx(979), gz(856), -3.261)
    expect(r.blocked).toBe(true)
    expect(r.end.y).toBeCloseTo(-3.261, 2)
    // A y within RESYNC_Y_M of the retained surface keeps it (small server corrections do not re-guess).
    t.place(x, z, -3.3)
    expect(t.settle(x + 0.1, z, -3.0).surface.kind).toBe('object')
  })
})
