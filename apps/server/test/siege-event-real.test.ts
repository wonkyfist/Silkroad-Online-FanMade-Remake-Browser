/**
 * Siege of Jangan, layer 4 on the real jangan-fields export (docs/SIEGE.md §6.3, §14; skipped without it): every lane
 * of content/siege/jangan.json walks on the server's nav (outer legs with the walls standing, the foot of the wall at
 * the ditch rim, the gap with its segment breached, the inner legs to the Town Bell), the three gates are warded, and a
 * GM-started siege raises the Bell on the plaza, musters wave 1 at its approaches and sends it marching.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIEGE_EVENT_CODES } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { seeded } from './fixtures.ts'
import { sleep, startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const FIELDS = join(OUT, 'world/jangan-fields')
const HAVE = ['siege/walls.json', 'nav.bin', 'manifest.json'].every((f) => existsSync(join(FIELDS, f))) && existsSync(join(OUT, 'data/towns.json'))

describe.skipIf(!HAVE)('the siege on the real jangan-fields export', () => {
  let s: TestServer
  const logs: string[] = []
  const dataDir = HAVE ? mkdtempSync(join(tmpdir(), 'sro-siege-real-')) : ''

  beforeAll(async () => {
    s = await startTestServer({ logs, config: { outDir: OUT, dataDir, contentDir: join(REPO_ROOT, 'content'), serveStatic: false, tickHz: 20, rng: seeded(41), worldExport: 'jangan-fields', spawnMobs: false } })
  }, 180_000)
  afterAll(async () => {
    await s?.stopAndClean()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('every authored lane walks on the nav; three gates are warded', () => {
    const siege = s.ctx.gameplay.siege
    expect(siege.problem, logs.filter((l) => l.startsWith('siege')).join('\n')).toBe('')
    expect(siege.on).toBe(true)
    expect(siege.lanes.map((a) => a.approach)).toEqual(['W', 'S', 'E', 'N'])
    for (const a of siege.lanes) {
      expect(a.dropped, `${a.approach}: ${JSON.stringify(a.dropped)}`).toEqual([])
      expect(a.lanes.length, a.approach).toBe(3)
    }
    expect(siege.wards.map((w) => w.gate).sort()).toEqual(['E-gate', 'S-gate', 'W-gate'])
  })

  it('a GM siege: the Bell on the plaza, wave 1 at the musters, then marching; stop', async () => {
    const g = s.ctx.gameplay
    const siege = g.siege
    const r = siege.gm(null, ['start', '0.05'], Date.now())
    expect(r.ok, r.message).toBe(true)
    const bell = siege.bellMob()!
    expect(bell.def.code).toBe(SIEGE_EVENT_CODES.bell)
    expect(Math.hypot(bell.pos[0] - 97, bell.pos[2] + 63)).toBeLessThan(10)
    const army = () => [...s.ctx.world.mobs.values()].filter((m) => m.siege && m.siege.role !== 'bell' && m.ai !== 'dead')
    expect(army().length).toBe(28)
    // every monster stands within 25 m of its approach's muster
    for (const m of army()) {
      const al = siege.lanes.find((a) => a.approach === m.siege!.approach)!
      expect(Math.hypot(m.pos[0] - al.muster[0], m.pos[2] - al.muster[1])).toBeLessThan(25)
    }
    await sleep(9000)
    expect(siege.ev!.phase).toBe('wave1')
    const moving = army().filter((m) => m.move !== null)
    expect(moving.length).toBeGreaterThan(10)
    // they walk their lanes away from the musters, toward the town
    const dist = (m: (typeof moving)[number]) => {
      const al = siege.lanes.find((a) => a.approach === m.siege!.approach)!
      const p = s.ctx.world.positionAt(m, Date.now())
      return Math.hypot(p[0] - al.muster[0], p[2] - al.muster[1])
    }
    expect(army().filter((m) => dist(m) > 12).length).toBeGreaterThan(5)
    expect(siege.gm(null, ['stop'], Date.now()).ok).toBe(true)
    expect(siege.ev!.outcome).toBe('cancelled')
  }, 60_000)
})
