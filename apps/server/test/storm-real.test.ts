/**
 * Storms on the real Jangan export (docs/WEATHER.md §12; skips without work/out): a held storm on a running server with
 * every real nest. The module reads the storm off the weather, thins the small animals, speeds the undead, charges a
 * monster, keeps the uniques untouched, and gives everything back when the storm is over, without a module
 * error in the log.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { seeded } from './fixtures.ts'
import { sleep, startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const HAVE = existsSync(join(OUT, 'world/jangan/manifest.json')) && ['mobs', 'nests', 'items', 'levels', 'drops', 'towns'].every((f) => existsSync(join(OUT, `data/${f}.json`)))

describe.skipIf(!HAVE)('storms on the real Jangan', () => {
  let s: TestServer
  const logs: string[] = []

  beforeAll(async () => {
    s = await startTestServer({ config: { outDir: OUT, tickHz: 20, rng: seeded(3), weather: 'auto' }, logs })
  })
  afterAll(async () => {
    await s?.stopAndClean()
  })

  const alive = (code: string) => [...s.ctx.world.mobs.values()].filter((m) => m.def.code === code && m.ai !== 'dead').length

  it('a storm thins the Mangyang, speeds the ghosts, charges a monster but never a unique; all back after', async () => {
    const g = s.ctx.gameplay
    const mang0 = alive('MOB_CH_MANGNYANG')
    // the converted Jangan export holds the Mangyang field and the Big-Eyed Ghosts (the rest lies outside it)
    const ghosts0 = alive('MOB_CH_BIGEYEGHOST')
    expect(mang0).toBeGreaterThan(50)
    expect(ghosts0).toBeGreaterThan(5)
    expect(g.weather.gm(['storm', '5', '0']).ok).toBe(true)
    await sleep(1500)
    expect(g.storm.env.storm).toBe(1)
    expect(g.storm.current.phase).toBe('storm')
    // reconcile: every 5 s, two per nest per pass
    await sleep(11_000)
    expect(alive('MOB_CH_MANGNYANG')).toBeLessThan(mang0 - 40)
    expect(alive('MOB_CH_BIGEYEGHOST')).toBe(ghosts0) // undead: no count change
    const tiger = [...s.ctx.world.mobs.values()].find((m) => m.def.code === 'MOB_CH_BIGEYEGHOST' && m.ai !== 'dead')!
    expect(g.storm.speed(tiger, 4)).toBeCloseTo(5, 9)
    expect(g.storm.gm(['charge', String(tiger.id)]).ok).toBe(true)
    expect(s.ctx.world.state(tiger).charged).toBe(true)
    const girl = [...s.ctx.world.mobs.values()].find((m) => m.variant === 'unique')
    if (girl) {
      expect(g.storm.charge(girl, Date.now())).toBe(false)
      expect(g.storm.sight(girl)).toBe(girl.sightRange)
    }
    expect(g.weather.gm(['clear', '5', '0']).ok).toBe(true)
    await sleep(1500)
    expect(g.storm.current.phase).not.toBe('storm')
    expect(g.storm.isCharged(tiger)).toBe(false)
    await sleep(11_000)
    expect(alive('MOB_CH_MANGNYANG')).toBeGreaterThanOrEqual(mang0 - 2)
    expect(logs.filter((l) => /storm.*failed|failed.*storm/i.test(l))).toEqual([])
  }, 60_000)
})
