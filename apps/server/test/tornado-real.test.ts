/**
 * The lightning tornado on the real Jangan export (docs/WEATHER.md §13; skips without work/out): paths planned around
 * the town on the real navmesh stay on open ground, off the water planes and away from every safe area, and every
 * throw landing found from along them is the end of a legal straight walk on the navmesh (never through a wall), on
 * placeable ground, dry and outside the towns.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TORNADO_TABLE } from '@sro/shared'
import { REPO_ROOT } from '../src/config.ts'
import type { MeshNav } from '../src/nav.ts'
import { rectDist } from '../src/storm/tornado-path.ts'
import { seeded } from './fixtures.ts'
import { sleep, startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const HAVE = existsSync(join(OUT, 'world/jangan/manifest.json')) && ['mobs', 'nests', 'items', 'levels', 'drops', 'towns'].every((f) => existsSync(join(OUT, `data/${f}.json`)))

describe.skipIf(!HAVE)('the tornado on the real Jangan', () => {
  let s: TestServer
  const logs: string[] = []

  beforeAll(async () => {
    s = await startTestServer({ config: { outDir: OUT, tickHz: 20, rng: seeded(11), weather: 'auto', spawnMobs: false }, logs })
  })
  afterAll(async () => {
    await s?.stopAndClean()
  })

  it('plans paths on open dry ground away from the towns; throw landings are legal navmesh walks', async () => {
    const g = s.ctx.gameplay
    const tor = g.tornado
    tor.prepare()
    for (let i = 0; i < 100 && !logs.some((l) => /tornado: .*water/.test(l)); i++) await sleep(100)
    expect(g.nav.kind).toBe('mesh')
    const nav = g.nav as MeshNav
    const towns = g.data.towns.filter((t) => t.world === g.config.world && t.safeArea)
    expect(towns.length).toBeGreaterThan(0)
    const sp = s.ctx.setup.spawn
    let paths = 0
    let landings = 0
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2
      const s0 = tor.spawn({ x: sp.x + Math.sin(a) * 350, z: sp.z + Math.cos(a) * 350 }, Date.now(), { gm: true, lifeMs: 120_000 })
      if (!s0) continue
      paths++
      for (const q of s0.path) {
        for (const t of towns) expect(rectDist(q[0], q[2], t.safeArea!)).toBeGreaterThanOrEqual(TORNADO_TABLE.townMarginM - 0.5)
        const p = nav.place(q[0], q[2], Infinity)
        expect(p).not.toBeNull()
        if (p!.surface?.kind === 'terrain') expect(nav.terrainOpen(p!.x, p!.z)).toBe(true)
      }
      for (const q of s0.path) {
        const from = nav.place(q[0] + 2, q[2] + 1, q[1])
        if (!from) continue
        const end = tor.landing(s0, from, q)
        if (!end) continue
        landings++
        const walk = nav.walk(from, end.x, end.z)
        expect(walk).not.toBeNull()
        expect(Math.hypot(walk!.end.x - end.x, walk!.end.z - end.z)).toBeLessThan(0.05)
        expect(g.nav.canWalk(end.x, end.z)).toBe(true)
        expect(g.data.inSafeArea(g.config.world, end.x, end.z)).toBe(false)
        expect(Math.hypot(end.x - from.x, end.z - from.z)).toBeGreaterThanOrEqual(TORNADO_TABLE.throwMinM)
      }
      tor.lift(Date.now())
    }
    expect(paths).toBeGreaterThan(3)
    expect(landings).toBeGreaterThan(20)
    expect(logs.filter((l) => /tornado.*failed/i.test(l))).toEqual([])
  }, 60_000)
})
