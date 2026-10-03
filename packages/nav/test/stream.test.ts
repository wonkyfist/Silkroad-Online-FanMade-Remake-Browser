/**
 * Region streaming of the client nav (docs/FIELDS.md §3.8) on the real 3 x 3 Jangan export (work/out/world/jangan/
 * nav.bin; skipped without it). The export has no nav/ folder, so the per-region chunks and the objects-only file are
 * encoded here from nav.bin with encodeNavData, exactly as the converter splits them. A NavWorld built from the
 * objects-only data plus each region chunk added one by one must answer like the full nav.bin; a chord into a removed
 * region is blocked at its border.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NavWorld, decodeNavData, encodeNavData, type NavData, type NavPosition } from '../src/index.ts'

const FILE = join(fileURLToPath(new URL('../../../', import.meta.url)), 'work', 'out', 'world', 'jangan', 'nav.bin')

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe.skipIf(!existsSync(FILE))('streamed NavWorld (objects once, terrain per region)', () => {
  const full: NavData = decodeNavData(new Uint8Array(readFileSync(FILE)))
  const objects = decodeNavData(encodeNavData({ version: full.version, regions: [], models: full.models, instances: full.instances }))
  const chunks = full.regions.map(r => decodeNavData(encodeNavData({ version: full.version, regions: [r], models: [], instances: [] })).regions[0]!)
  const whole = new NavWorld(full)
  const minX = Math.min(...full.regions.map(r => r.rx)) * 1920
  const maxX = (Math.max(...full.regions.map(r => r.rx)) + 1) * 1920
  const minZ = Math.min(...full.regions.map(r => r.rz)) * 1920
  const maxZ = (Math.max(...full.regions.map(r => r.rz)) + 1) * 1920

  it('encodes each chunk bit-identical to its region of nav.bin', () => {
    expect(full.regions).toHaveLength(9)
    for (const [i, r] of full.regions.entries()) {
      const c = chunks[i]!
      expect(c.id).toBe(r.id)
      expect(Buffer.from(c.heights.buffer, c.heights.byteOffset, c.heights.byteLength)
        .equals(Buffer.from(r.heights.buffer, r.heights.byteOffset, r.heights.byteLength))).toBe(true)
      expect([...c.tileCells]).toEqual([...r.tileCells])
    }
  })

  it('answers like the full nav.bin once every region is added, on 1,000 random chords', () => {
    const nav = new NavWorld(objects)
    expect(nav.instanceCount).toBe(whole.instanceCount)
    // Before any terrain: points are unloaded terrain.
    expect(Number.isNaN(nav.terrainHeight(minX + 100, minZ + 100))).toBe(true)
    for (const c of chunks) nav.addRegion(c)
    for (const c of chunks) expect(nav.terrainHeight(c.rx * 1920 + 960, c.rz * 1920 + 960)).toBe(whole.terrainHeight(c.rx * 1920 + 960, c.rz * 1920 + 960))
    const rand = rng(1234)
    let compared = 0
    for (let i = 0; i < 1000; i++) {
      const x0 = minX + rand() * (maxX - minX)
      const z0 = minZ + rand() * (maxZ - minZ)
      const x1 = x0 + (rand() - 0.5) * 1200
      const z1 = z0 + (rand() - 0.5) * 1200
      const a = whole.locate(x0, z0, Infinity)
      const b = nav.locate(x0, z0, Infinity)
      expect(b).toEqual(a)
      if (!a) continue
      const ra = whole.moveStraight(a, x1, z1)
      const rb = nav.moveStraight(b as NavPosition, x1, z1)
      expect(rb.blocked).toBe(ra.blocked)
      expect(rb.end).toEqual(ra.end)
      expect(rb.legs.length).toBe(ra.legs.length)
      compared++
    }
    expect(compared).toBeGreaterThan(500)
  })

  it('agrees with nav.bin on 1,000 chords inside a partly loaded set (2 x 2 of the 3 x 3)', () => {
    const nav = new NavWorld(objects)
    const block = chunks.filter(c => c.rx <= 168 && c.rz <= 97)
    expect(block).toHaveLength(4)
    for (const c of block) nav.addRegion(c) // one by one
    const x0 = 167 * 1920 + 1, x1 = 169 * 1920 - 1, z0 = 96 * 1920 + 1, z1 = 98 * 1920 - 1
    const rand = rng(777)
    let compared = 0
    for (let i = 0; i < 1000; i++) {
      const ax = x0 + rand() * (x1 - x0), az = z0 + rand() * (z1 - z0)
      const bx = x0 + rand() * (x1 - x0), bz = z0 + rand() * (z1 - z0)
      const a = whole.locate(ax, az, Infinity)
      expect(nav.locate(ax, az, Infinity)).toEqual(a)
      if (!a) continue
      const ra = whole.moveStraight(a, bx, bz)
      const rb = nav.moveStraight(a, bx, bz)
      expect(rb.blocked).toBe(ra.blocked)
      expect(rb.end).toEqual(ra.end)
      compared++
    }
    expect(compared).toBeGreaterThan(500)
    // Outside the loaded block the terrain is unloaded.
    expect(Number.isNaN(nav.terrainHeight(169 * 1920 + 960, 97 * 1920 + 960))).toBe(true)
  })

  it('blocks a chord into a removed region at its border, and forgets its components', () => {
    const nav = new NavWorld(objects)
    for (const c of chunks) nav.addRegion(c)
    // Remove the east column's middle region (169, 97); walk east from the middle of 168, 97.
    const removed = full.regions.find(r => r.rx === 169 && r.rz === 97)!
    const inside = { x: 169 * 1920 + 960, z: 97 * 1920 + 960 }
    const before = nav.locate(inside.x, inside.z, -Infinity)
    expect(before).not.toBeNull()
    expect(nav.componentOf(before!)).toBeGreaterThanOrEqual(0)
    expect(nav.removeRegion(removed.id)).toBe(true)
    expect(nav.removeRegion(removed.id)).toBe(false)
    expect(Number.isNaN(nav.terrainHeight(inside.x, inside.z))).toBe(true)
    expect(nav.terrainOpen(inside.x, inside.z)).toBe(false)
    // The components were rebuilt without that terrain.
    expect(nav.componentOf({ x: inside.x, z: inside.z, surface: { kind: 'terrain' } })).toBe(-1)
    // Find an open terrain start on the 168, 97 side of the border, on the same row.
    const rand = rng(99)
    let tested = 0
    for (let i = 0; i < 200 && tested < 20; i++) {
      const z = 97 * 1920 + 100 + rand() * 1720
      const x = 169 * 1920 - 50 - rand() * 400
      const start = nav.locate(x, z, -Infinity)
      if (!start || start.surface.kind !== 'terrain') continue
      const r = nav.moveStraight(start, 169 * 1920 + 900, z)
      // Either something in town stops it earlier, or it stops at the border of the missing region.
      expect(r.end.x).toBeLessThanOrEqual(169 * 1920 + 1e-6)
      if (r.blocked && r.end.x > 169 * 1920 - 1) tested++
    }
    expect(tested).toBeGreaterThan(0)
    // Adding it back restores the full answers.
    nav.addRegion(removed)
    expect(nav.terrainHeight(inside.x, inside.z)).toBe(whole.terrainHeight(inside.x, inside.z))
  })
})
