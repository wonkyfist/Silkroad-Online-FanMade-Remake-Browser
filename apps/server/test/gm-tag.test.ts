/**
 * The [GM] name tag (docs/UX_GAPS.md §5.2, lane UX-B): a gm/admin player carries `gm: true` in its EntityState for
 * everyone, and a grant or revoke by the owner (here `store.setRole`, as role-policy.test.ts does it) reaches the
 * others as `entityUpdate {gm}` within the role poll. Display only: no role path is added.
 */
import type { Role } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'

let s: TestServer
let seq = 0

async function inWorld(role: Role = 'player'): Promise<{ c: Client; id: number; accountId: number }> {
  const acc = await newAccount(s.url, 'gmt')
  const accountId = s.ctx.store.accountByName(acc.username)!.id
  if (role !== 'player') s.ctx.store.setRole(accountId, role) // test setup = the owner's CLI
  const c = await Client.login(s.url, acc.token)
  c.send({ t: 'charCreate', name: `Gt${Date.now() % 1e5}${++seq}`.slice(0, 12), model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
  const ch = (await c.next('charCreated')).character
  c.send({ t: 'enterWorld', id: ch.id })
  const enter = await c.next('worldEnter')
  return { c, id: enter.self.id, accountId }
}

beforeAll(async () => {
  s = await startTestServer({ files: { 'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [10, 0, -10] }) } })
})
afterAll(async () => {
  await s.stopAndClean()
})

describe('GM tag', () => {
  it('a GM shows gm: true to others (worldEnter and spawn); a player does not', async () => {
    const gm = await inWorld('gm')
    const p = await inWorld()
    // p entered after the GM: the GM is in its worldEnter entities.
    const enter = p.c.log.find((m) => m.t === 'worldEnter')
    const seen = enter?.t === 'worldEnter' ? enter.entities.find((e) => e.id === gm.id) : undefined
    expect(seen?.gm).toBe(true)
    expect(enter?.t === 'worldEnter' && enter.self.gm).toBeFalsy()
    // The GM received p as a spawn, without the tag.
    const spawn = await gm.c.next('spawn', (m) => m.entity.id === p.id)
    expect(spawn.entity.gm).toBeUndefined()
    gm.c.close()
    p.c.close()
  })

  it('grant and revoke by the owner reach others as entityUpdate {gm} within the role poll', async () => {
    const a = await inWorld()
    const b = await inWorld()
    s.ctx.store.setRole(a.accountId, 'gm')
    s.ctx.refreshRoles(true) // the poll only notices writes from another process (the CLI); same process here
    expect(await b.c.next('entityUpdate', (m) => m.id === a.id && m.gm !== undefined)).toMatchObject({ id: a.id, gm: true })
    expect(await a.c.next('entityUpdate', (m) => m.id === a.id && m.gm !== undefined)).toMatchObject({ gm: true })
    s.ctx.store.setRole(a.accountId, 'player')
    s.ctx.refreshRoles(true)
    expect(await b.c.next('entityUpdate', (m) => m.id === a.id && m.gm !== undefined)).toMatchObject({ id: a.id, gm: false })
    // A third client entering now sees no tag.
    const c = await inWorld()
    const enter = c.c.log.find((m) => m.t === 'worldEnter')
    expect(enter?.t === 'worldEnter' && enter.entities.find((e) => e.id === a.id)?.gm).toBeFalsy()
    for (const x of [a, b, c]) x.c.close()
  })
})
