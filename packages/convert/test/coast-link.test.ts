/**
 * S1's in-bounds link (docs/COAST.md §3.5, §9.3 G1; WAVE_PLAN6 D29): with every region outside the playable rectangle
 * closed (the server's clamp), the walkable south beach reaches the town's walkable component through coast.json
 * `openTiles`, and not without them. Read on the exported nav.bin of jangan-fields (the retail openness is the same
 * before and after the coast inside the bounds; the link's tiles are applied here). Skips without that export.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { NVM_TILES } from '@sro/formats'
import { decodeNavData, NavWorld, type NavData } from '@sro/nav'
import { REPO_ROOT } from '../src/node-io.ts'
import { parseCoastConfig, type CoastConfig } from '../src/world/coast/config.ts'
import { S1_POINT } from '../src/world/coast/hook.ts'
import { closeRing, reachesBothWays, tileInRects } from '../src/world/coast/links.ts'
import { openTilesInNavRegion } from '../src/world/coast/navgen.ts'
import type { WorldManifest } from '../src/world/manifest.ts'

const OUT = join(REPO_ROOT, 'work', 'out', 'world', 'jangan-fields')
const hasExport = existsSync(join(OUT, 'manifest.json')) && existsSync(join(OUT, 'nav.bin'))

describe.skipIf(!hasExport)('S1 reaches the town inside the bounds (openTiles, G1)', () => {
  let cfg: CoastConfig
  let m: WorldManifest
  let home: { x: number; y: number; z: number }
  const s1 = { x: S1_POINT[0] * 1920, z: S1_POINT[1] * 1920 }
  const load = (): NavData => decodeNavData(new Uint8Array(readFileSync(join(OUT, 'nav.bin'))))

  beforeAll(() => {
    cfg = parseCoastConfig(readFileSync(join(REPO_ROOT, 'content', 'coast', 'coast.json'), 'utf8'))
    m = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as WorldManifest
    const o = m.space.originRegion
    home = { x: o.x * 1920 + m.spawn!.x * 10, y: m.spawn!.y * 10, z: o.z * 1920 - m.spawn!.z * 10 }
  })

  it('keeps the link inside the playable rectangle and small', () => {
    const p = m.stream!.playable
    expect(cfg.openTiles.length).toBeGreaterThan(0)
    let tiles = 0
    for (const q of cfg.openTiles) {
      expect(q.x[0]).toBeGreaterThanOrEqual(p.x0)
      expect(q.x[1]).toBeLessThanOrEqual(p.x1 + 1)
      expect(q.z[0]).toBeGreaterThanOrEqual(p.z0)
      expect(q.z[1]).toBeLessThanOrEqual(p.z1 + 1)
      tiles += Math.round((q.x[1] - q.x[0]) * NVM_TILES) * Math.round((q.z[1] - q.z[0]) * NVM_TILES)
    }
    expect(tiles).toBeLessThan(800)
  })

  it('S1 reaches the town and back with the ring closed once the openTiles are open', () => {
    const data = load()
    const closed = closeRing(data, m.stream!.playable)
    for (const r of closed.regions) openTilesInNavRegion(r, cfg.openTiles)
    expect(reachesBothWays(new NavWorld(closed), s1, home)).toBe(true)
  }, 120_000)

  it('without the openTiles (their tiles closed again) S1 is cut off inside the bounds, as the fact-check found', () => {
    const data = load()
    const closed = closeRing(data, m.stream!.playable)
    // the fact-check is about the retail openness: tiles a kept World Editor publish forced open (the Walkable brush,
    // report.edits.nav; e.g. 169,90-92 next to the beach) may join S1 to the town on their own, so they close again too
    const nav = m.report.edits?.nav as { regions?: Array<{ x: number; z: number; openedTiles?: number[] }> } | undefined
    const editOpened = new Map((nav?.regions ?? []).map(r => [`${r.x},${r.z}`, new Set(r.openedTiles ?? [])]))
    for (const r of closed.regions) {
      if (r.openCellCount === 0) continue
      const forced = editOpened.get(`${r.rx},${r.rz}`)
      for (let t = 0; t < NVM_TILES * NVM_TILES; t++) {
        if (forced?.has(t) || tileInRects(cfg.openTiles, r.rx * NVM_TILES + (t % NVM_TILES), r.rz * NVM_TILES + Math.floor(t / NVM_TILES))) r.tileCells[t] = r.openCellCount
      }
    }
    expect(reachesBothWays(new NavWorld(closed), s1, home)).toBe(false)
  }, 120_000)
})
