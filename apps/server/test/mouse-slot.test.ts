/**
 * The mouse quick slot (retail GDR_TMPQS_0; @sro/shared MOUSE_SLOT, migration 11): `hotbarSet` addresses it as slot
 * MOUSE_SLOT with the hotbar's rules, the server stores it per character, and the next `skills` snapshot carries it as
 * `mouse` (so it follows the character to another PC). The 40 hotbar slots are untouched by it.
 */
import { HOTBAR_SLOTS, MOUSE_SLOT, parseClientMessage, parseServerMessage, type ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'
import { ITEMS, LEVELS, contentFiles, seeded } from './fixtures.ts'

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

describe('the mouse quick slot on the wire', () => {
  it('is slot 40, right after the 40 hotbar slots, and both directions validate it', () => {
    expect(MOUSE_SLOT).toBe(HOTBAR_SLOTS)
    const set = parseClientMessage(JSON.stringify({ t: 'hotbarSet', slot: MOUSE_SLOT, entry: { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' } }))
    expect(set).toMatchObject({ ok: true, msg: { slot: 40 } })
    expect(parseClientMessage(JSON.stringify({ t: 'hotbarSet', slot: MOUSE_SLOT + 1, entry: null })).ok).toBe(false)
    const snap = { t: 'skills', masteries: {}, skills: [], hotbar: new Array(HOTBAR_SLOTS).fill(null), mouse: { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' } }
    const parsed = parseServerMessage(JSON.stringify(snap))
    expect(parsed.ok && (parsed.msg as Msg<'skills'>).mouse).toEqual({ kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' })
    const upd = parseServerMessage(JSON.stringify({ t: 'skillsUpdate', hotbar: [{ slot: MOUSE_SLOT, entry: null }] }))
    expect(upd.ok && (upd.msg as Msg<'skillsUpdate'>).hotbar).toEqual([{ slot: MOUSE_SLOT, entry: null }])
  })
})

describe('the mouse quick slot on a server', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await startTestServer({
      config: { moveSpeed: 30, tickHz: 20, rng: seeded(40) },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [50, 0, -50], bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
        ...contentFiles({ items: ITEMS, levels: LEVELS }),
      },
    })
  })
  afterAll(async () => {
    await s?.stopAndClean()
  })

  it('is saved per character and comes back in the next snapshot; non-consumables are refused as on the bar', async () => {
    const acc = await newAccount(s.url, 'mouse')
    let c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: 'Wheel', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const first = await c.next('skills')
    expect(first.mouse).toBeUndefined()

    c.send({ t: 'hotbarSet', slot: MOUSE_SLOT, entry: { kind: 'item', code: 'ITEM_CH_BLADE_02_A' } })
    expect(await c.next('actionResult', (m) => m.re === 'hotbarSet')).toMatchObject({ ok: false, reason: 'not_usable' })

    c.send({ t: 'hotbarSet', slot: MOUSE_SLOT, entry: { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' } })
    expect(await c.next('actionResult', (m) => m.re === 'hotbarSet')).toMatchObject({ ok: true })
    const upd = await c.next('skillsUpdate', (m) => !!m.hotbar)
    expect(upd.hotbar).toEqual([{ slot: MOUSE_SLOT, entry: { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' } }])
    c.close()
    await c.closed

    c = await Client.login(s.url, acc.token)
    c.send({ t: 'enterWorld', id: ch.id })
    const again = await c.next('skills')
    expect(again.mouse).toEqual({ kind: 'item', code: 'ITEM_ETC_HP_POTION_01' })
    expect(again.hotbar.every((e) => e === null)).toBe(true)

    c.send({ t: 'hotbarSet', slot: MOUSE_SLOT, entry: null })
    expect(await c.next('actionResult', (m) => m.re === 'hotbarSet')).toMatchObject({ ok: true })
    c.close()
    await c.closed
    c = await Client.login(s.url, acc.token)
    c.send({ t: 'enterWorld', id: ch.id })
    expect((await c.next('skills')).mouse).toBeUndefined()
    c.close()
    await c.closed
  })
})
