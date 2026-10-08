/**
 * The character creator (docs/CHARACTERS.md §16.10): migration 24 (look_custom, the girls' outfit accessories), the
 * one-time re-customise (charLook: owner, lobby, once, body, rate limit, skip) and the `customise` flag on summaries.
 */
import { LOOK_BUILD_DEFAULT, defaultLook, parseClientMessage, type CharLook } from '@sro/shared'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate, openStore } from '../src/db.ts'
import { ITEMS, LEVELS, contentFiles } from './fixtures.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'

let s: TestServer
let n = 0

beforeAll(async () => {
  s = await startTestServer({
    config: { tickHz: 20 },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [50, 0, -50], bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
      ...contentFiles({ items: ITEMS, levels: LEVELS }),
    },
  })
})

afterAll(async () => {
  await s.stopAndClean()
})

async function lobby() {
  const acc = await newAccount(s.url, 'crea')
  return Client.login(s.url, acc.token)
}

const custom = (): CharLook => ({
  ...defaultLook('f'),
  outfit: '01',
  hair: '06',
  makeup: '27',
  iris: '12',
  hairColor: 21,
  skinTone: 9,
  skinShift: -15,
  markings: ['paint_gold'],
  accessories: ['nails'],
  height: 3,
  build: { ...LOOK_BUILD_DEFAULT.f, weight: 70, chest: 60 },
})

describe('the creator (§16.10)', () => {
  it('a classic character is offered the creator once; a creator-made one never', async () => {
    const c = await lobby()
    c.send({ t: 'charCreate', name: `Old${++n}`, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'sword' })
    const old = (await c.next('charCreated')).character
    expect(old.customise).toBe(true)
    c.send({ t: 'charCreate', name: `New${++n}`, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'sword', look: custom() })
    const made = (await c.next('charCreated')).character
    expect(made.customise).toBeUndefined()
    expect(made.look).toEqual(custom())
    c.send({ t: 'charList' })
    const list = (await c.next('charList')).characters
    expect(list.find((x) => x.id === old.id)?.customise).toBe(true)
    expect(list.find((x) => x.id === made.id)?.customise).toBeUndefined()
    c.close()
    await c.closed
  })

  it('charLook saves the look once (height column too), keeps level and items; a second try, another body, another owner or the world are refused', async () => {
    const c = await lobby()
    c.send({ t: 'charCreate', name: `Re${++n}`, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'spear', height: 1 })
    const old = (await c.next('charCreated')).character
    const before = s.ctx.store.characterById(old.id)!
    const items = s.ctx.store.loadInventory(old.id)
    // another body's look
    c.send({ t: 'charLook', id: old.id, look: { ...defaultLook('m'), height: 2 } })
    expect(await c.next('error')).toMatchObject({ code: 'bad_request', re: 'charLook' })
    // someone else's character
    const d = await lobby()
    d.send({ t: 'charLook', id: old.id, look: custom() })
    expect(await d.next('error')).toMatchObject({ code: 'not_found' })
    d.close()
    // the look
    c.send({ t: 'charLook', id: old.id, look: custom() })
    const set = (await c.next('charLookSet')).character
    expect(set.look).toEqual(custom())
    expect(set.customise).toBeUndefined()
    expect(set.height).toBe(3)
    const after = s.ctx.store.characterById(old.id)!
    expect(after).toMatchObject({ level: before.level, exp: before.exp, gold: before.gold, height: 3, look_custom: 1 })
    expect(s.ctx.store.loadInventory(old.id)).toEqual(items)
    // once only
    c.send({ t: 'charLook', id: old.id, look: { ...custom(), hairColor: 3 } })
    expect(await c.next('error')).toMatchObject({ code: 'bad_request', re: 'charLook' })
    expect(JSON.parse(s.ctx.store.characterById(old.id)!.look!)).toEqual(custom())
    // only in the lobby
    c.send({ t: 'charCreate', name: `In${++n}`, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'sword' })
    const other = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: old.id })
    await c.next('worldEnter')
    c.send({ t: 'charLook', id: other.id })
    expect(await c.next('error')).toMatchObject({ code: 'already_in_world' })
    c.close()
    await Promise.all([c.closed, d.closed])
  })

  it('skipping keeps the default look and uses the offer up; the request is rate-limited', async () => {
    const c = await lobby()
    const ids: number[] = []
    for (let i = 0; i < 4; i++) {
      c.send({ t: 'charCreate', name: `Sk${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'bow' })
      ids.push((await c.next('charCreated')).character.id)
    }
    const look0 = s.ctx.store.characterById(ids[0]!)!.look
    c.send({ t: 'charLook', id: ids[0]! })
    const kept = (await c.next('charLookSet')).character
    expect(kept.customise).toBeUndefined()
    expect(s.ctx.store.characterById(ids[0]!)!.look).toBe(look0)
    // three tries per burst (CLIENT_RATE_LIMITS.charLook): the next ones are refused, not struck
    for (const id of ids.slice(1, 3)) {
      c.send({ t: 'charLook', id })
      await c.next('charLookSet')
    }
    c.send({ t: 'charLook', id: ids[3]! })
    expect(await c.next('error')).toMatchObject({ code: 'rate_limited' })
    expect(s.ctx.store.characterById(ids[3]!)!.look_custom).toBe(0)
    c.close()
    await c.closed
  })

  it('the wire: charLook parses its look strictly (catalogue ids, one paint), skip has none', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'charLook', id: 3 }))).toMatchObject({ ok: true, msg: { t: 'charLook', id: 3 } })
    expect(parseClientMessage(JSON.stringify({ t: 'charLook', id: 3, look: custom() }))).toMatchObject({ ok: true, msg: { look: custom() } })
    for (const bad of [{ ...custom(), makeup: '99' }, { ...custom(), markings: ['paint_red', 'paint_blue'] }, { ...custom(), accessories: ['crown'] }, { ...custom(), iris: '37' }]) {
      expect(parseClientMessage(JSON.stringify({ t: 'charLook', id: 3, look: bad })).ok).toBe(false)
    }
    expect(parseClientMessage(JSON.stringify({ t: 'charLook', id: 3, extra: 1 })).ok).toBe(false)
  })
})

describe('migration 24: customise once', () => {
  it('every existing character is offered the creator; the girls keep the accessories their outfit showed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sro-m24-'))
    try {
      // a database from before the look (22): characters inserted, then the server opens it (23, 24 run)
      const raw = new Database(join(dir, 'game.db'))
      expect(migrate(raw, 22)).toBe(22)
      raw.prepare("INSERT INTO accounts (id, username, password_hash, created_at) VALUES (1, 'old', 'x', 0)").run()
      const add = raw.prepare("INSERT INTO characters (id, account_id, name, model, weapon, world, created_at, height, volume) VALUES (?, 1, ?, ?, 'sword', 'jangan', 0, 2, 2)")
      for (const id of [5, 6, 7, 8, 9, 10]) add.run(id, `C${id}`, id % 2 ? 'CHAR_CH_WOMAN_ADVENTURER' : 'CHAR_CH_MAN_ADVENTURER')
      raw.close()
      const store = openStore(dir)
      try {
        expect(store.schemaVersion).toBe(27)
        for (const id of [5, 6, 7, 8, 9, 10]) {
          const row = store.characterById(id)!
          const body = id % 2 ? 'f' : 'm'
          expect(row.look_custom).toBe(0)
          expect(JSON.parse(row.look!)).toEqual(defaultLook(body, id, 2, 2))
          if (body === 'f') expect(JSON.parse(row.look!).accessories).toContain('earrings')
        }
        expect(store.customiseLookOnce(5, null)).toBe(true)
        expect(store.customiseLookOnce(5, null)).toBe(false)
      } finally {
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
