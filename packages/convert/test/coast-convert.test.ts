/**
 * CST-C phases 1 and 2 end to end: `convertWorld` of jangan-fields with the coast (objects off, into a temporary folder; the
 * real re-convert is the lead's X1 checkpoint). About a minute and 1.5 GB, so it runs only with SRO_COAST_CONVERT=1
 * (and sro.config.json):
 *   SRO_COAST_CONVERT=1 pnpm vitest run packages/convert/test/coast-convert.test.ts
 *
 * Checks (docs/COAST.md §12.1, §12.13): the manifest validates and report.coast carries no problem; the playable
 * regions outside the S1 strip are the retail terrain bit for bit; every region seam, synthetic ones included, is
 * bit-equal; the four height copies of every nav region agree (terrain, debug navmesh, nav chunk, nav.bin); synthetic
 * regions have no navigation; S1 reaches the town inside the bounds; tp beach-south lands on sand above the sea; the
 * sand tiles sound like sand; coast/field.png matches manifest.coast; the corridor's look-only regions (phase 2,
 * Option A) carry their retail terrain.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assembleRegionGrid, parseMapM } from '@sro/formats'
import { decodeNavData } from '@sro/nav'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { convertWorld, regionRange, WORLD_PRESETS } from '../src/world/convert-world.ts'
import { decodeNavmeshBin, decodeTerrainBin } from '../src/world/format.ts'
import { validateWorldManifest, type WorldManifest } from '../src/world/manifest.ts'
import { decodePng } from '../src/world/verify.ts'

const run = process.env.SRO_COAST_CONVERT === '1' && existsSync(join(REPO_ROOT, 'sro.config.json'))

describe.skipIf(!run)('convertWorld jangan-fields with the coast (phase 2)', () => {
  let dir: string
  let m: WorldManifest
  const G = 97

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sro-coast-'))
    const p = WORLD_PRESETS['jangan-fields']!
    m = (await convertWorld({
      name: 'jangan-fields', regions: regionRange(p.x0, p.x1, p.z0, p.z1), origin: p.centre, outDir: dir, objects: false, validate: false,
      spawnTeleport: p.spawnTeleport, coast: p.coast, playable: p.playable, stream: p.stream, places: p.places, displayName: p.displayName,
    })).manifest
  }, 900_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const terrain = (x: number, z: number) => {
    const r = m.regions.find(q => q.x === x && q.z === z)!
    return decodeTerrainBin(new Uint8Array(readFileSync(join(dir, r.terrain.file)))).heights
  }

  it('validates, with a clean report.coast and S1 linked to the town', () => {
    expect(validateWorldManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))).toEqual([])
    const c = m.report.coast as Record<string, any>
    expect(c.checks.problems).toEqual([])
    expect(c.s1Link).toEqual({ reachable: true, opened: expect.any(Number) })
    expect(c.s1Link.opened).toBeGreaterThan(0)
    expect(m.warnings.filter(w => w.startsWith('coast'))).toEqual([])
  })

  it('adds synthetic regions with no navigation, a lightmap and a minimap', () => {
    const syn = m.regions.filter(r => r.synthetic)
    expect(syn.length).toBeGreaterThan(100)
    const look = new Set((m.report.coast as Record<string, any>).emitted.lookOnly as string[])
    const navIds = new Set(m.nav!.regions)
    for (const r of syn) {
      expect(r.navmesh).toBeNull()
      expect(navIds.has(r.id)).toBe(false)
      expect(r.lightmap).not.toBeNull()
      expect(r.minimap).not.toBeNull()
      // a made-up region has no water (the ocean draws the sea); a look-only one keeps its retail ponds
      if (!look.has(`${r.x},${r.z}`)) expect(r.blocks.every(b => b.water === null)).toBe(true)
    }
    expect(m.nav!.regions.length).toBe(307)
  })

  it('builds the look-only corridor regions (Option A, phase 2) from their retail terrain', () => {
    const look = (m.report.coast as Record<string, any>).emitted.lookOnly as string[]
    expect(look.length).toBeGreaterThanOrEqual(12)
    const map = openArchive('Map')
    let rows = 0
    for (const key of look) {
      const [x, z] = key.split(',').map(Number) as [number, number]
      expect(x).toBeLessThan(155)
      expect(m.regions.find(q => q.x === x && q.z === z)!.synthetic).toBe(true)
      const grid = assembleRegionGrid(parseMapM(map.read(`${z}/${x}.m`)))
      const h = terrain(x, z)
      let diff = 0
      for (let gz = 0; gz < G; gz++) {
        const zz = z + gz / 96
        if (zz < 96.55 || zz > 103.85) continue
        rows++
        for (let gx = 0; gx < G; gx++) if (h[gz * G + gx] !== Math.fround(grid.heights[gz * G + gx]! * 0.1)) diff++
      }
      expect(diff, key).toBe(0)
    }
    expect(rows).toBeGreaterThan(12 * 80)
  }, 120_000)

  it('keeps every playable region outside the S1 strip the retail terrain, bit for bit', () => {
    const map = openArchive('Map')
    const p = m.stream!.playable
    let same = 0
    for (let z = p.z0; z <= p.z1; z++) {
      for (let x = p.x0; x <= p.x1; x++) {
        const grid = assembleRegionGrid(parseMapM(map.read(`${z}/${x}.m`)))
        const h = terrain(x, z)
        let diff = 0
        for (let i = 0; i < h.length; i++) if (h[i] !== Math.fround(grid.heights[i]! * 0.1)) diff++
        if (z === 90 && x >= 165 && x <= 174) continue
        expect(diff, `${x},${z}`).toBe(0)
        same++
      }
    }
    expect(same).toBeGreaterThan(230)
  }, 120_000)

  it('keeps every region seam bit-equal, synthetic regions included', () => {
    const byKey = new Map(m.regions.map(r => [`${r.x},${r.z}`, r]))
    let seams = 0
    for (const r of m.regions) {
      const a = terrain(r.x, r.z)
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
        const n = byKey.get(`${r.x + dx},${r.z + dz}`)
        if (!n) continue
        const b = terrain(n.x, n.z)
        seams++
        for (let k = 0; k < G; k++) {
          if (dx) expect(a[k * G + 96]).toBe(b[k * G])
          else expect(a[96 * G + k]).toBe(b[k])
        }
      }
    }
    expect(seams).toBeGreaterThan(650)
  }, 300_000)

  it('writes the four height copies of every nav region consistently', () => {
    const nav = decodeNavData(new Uint8Array(readFileSync(join(dir, 'nav.bin'))))
    for (const reg of nav.regions) {
      const r = m.regions.find(q => q.id === reg.id)!
      const t = terrain(reg.rx, reg.rz)
      const dbg = decodeNavmeshBin(new Uint8Array(readFileSync(join(dir, r.navmesh!.file)))).heights
      const chunk = decodeNavData(new Uint8Array(readFileSync(join(dir, 'nav', `${reg.rx}_${reg.rz}.bin`)))).regions[0]!
      for (let i = 0; i < t.length; i++) {
        if (t[i] !== Math.fround(reg.heights[i]! * 0.1) || dbg[i] !== t[i] || chunk.heights[i] !== reg.heights[i]) {
          throw new Error(`region ${reg.rx},${reg.rz}: height copies differ at ${i}`)
        }
      }
    }
  }, 300_000)

  it('puts tp beach-south on the beach above the sea, and the sand tiles sound like sand', () => {
    const place = m.places!.find(p => p.name === 'beach-south')!
    expect(place.y).toBeGreaterThan(m.coast!.seaLevelM)
    for (const id of [407, 412]) expect(m.tiles.find(t => t.id === id)?.typeName).toBe('Sand')
  })

  it('writes coast/field.png as manifest.coast describes it', () => {
    const f = m.coast!.field
    const img = decodePng(readFileSync(join(dir, f.file)))
    expect([img.width, img.height]).toEqual([f.width, f.height])
    let sea = 0
    for (let i = 0; i < img.width * img.height; i++) if (img.rgba[i * 4]! > 127) sea++
    expect(sea / (img.width * img.height)).toBeGreaterThan(0.2)
  })
})
