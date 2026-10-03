/**
 * An invisible GM hitting a monster (gate fix): mobs may not target an invisible GM (AiHost.target), so a mob that
 * turned on one gave up at once, ran home (evading every hit) and healed to full. A GM who missed the first swing on a
 * 1-HP test mob could then never kill it: the wave-4 e2e `kill` helper timed out under load. Now the mob keeps the
 * GM's damage credit but does not turn on it; a visible player is still chased.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CombatHit } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { retaliate } from '../src/ai.ts'
import { REPO_ROOT } from '../src/config.ts'
import type { Mob } from '../src/world.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { seeded } from './fixtures.ts'

const OUT = join(REPO_ROOT, 'work/out')
const HAVE = ['data/mobs.json', 'data/nests.json', 'world/jangan/manifest.json'].every((f) => existsSync(join(OUT, f)))
const FIELD = ['108.97', '120']
const MISS: CombatHit[] = [{ outcome: 'miss', damage: 0, hp: 0 }]

describe('retaliate', () => {
  it('notice = false records the damage but leaves an idle mob idle', () => {
    const m = { ai: 'idle', target: null, damage: new Map<number, number>(), nextThinkAt: 5 } as unknown as Mob
    retaliate(m, 7, 3, false)
    expect(m).toMatchObject({ ai: 'idle', target: null, nextThinkAt: 5 })
    expect(m.damage.get(7)).toBe(3)
    retaliate(m, 8, 2)
    expect(m).toMatchObject({ ai: 'chase', target: 8 })
  })
})

describe.skipIf(!HAVE)('an invisible GM hitting a monster', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await startTestServer({ config: { outDir: OUT, serveStatic: false, moveSpeed: 30, tickHz: 20, rng: seeded(3) } })
  })
  afterAll(async () => {
    await s?.stopAndClean()
  })

  const enter = async (name: string) => {
    const acc = await newAccount(s.url, 'inv')
    s.ctx.store.setRole(s.ctx.store.accountByName(acc.username)!.id, 'gm')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const id = (await c.next('worldEnter')).self.id
    const gm = async (cmd: string, ...args: string[]) => {
      c.send({ t: 'gm', cmd, args })
      return c.next('gmResult')
    }
    expect((await gm('tp', ...FIELD)).ok).toBe(true)
    return { c, gm, player: () => s.ctx.world.players.get(id)! }
  }

  it('a missed swing keeps the mob idle at 1 HP (no run home, no heal); the next hit kills it with credit', async () => {
    const g = await enter('Ghost')
    expect((await g.gm('invis', 'on')).ok).toBe(true)
    const r = await g.gm('spawn', 'MOB_CH_MANGNYANG', '1')
    const m = s.ctx.world.mobs.get((r.data as { ids: number[] }).ids[0])!
    m.hp = 1
    m.nextRegenAt = Date.now() + 1e9
    s.ctx.gameplay.dealHits(g.player(), m, MISS, {}, Date.now())
    await sleep(500)
    expect(m.ai).toBe('idle')
    expect(m.hp).toBe(1)
    expect(m.damage.has(g.player().id)).toBe(true)
    expect(s.ctx.gameplay.dealHits(g.player(), m, [{ outcome: 'hit', damage: 5, hp: 0 }], {}, Date.now()).killed).toBe(true)
    g.c.close()
  })

  it('a visible GM is still chased', async () => {
    const g = await enter('Seen')
    const r = await g.gm('spawn', 'MOB_CH_MANGNYANG', '1')
    const m = s.ctx.world.mobs.get((r.data as { ids: number[] }).ids[0])!
    s.ctx.gameplay.dealHits(g.player(), m, MISS, {}, Date.now())
    expect(m).toMatchObject({ ai: 'chase', target: g.player().id })
    g.c.close()
  })
})
