/**
 * Character appearance (docs/CHARACTER_SCALE.md, protocol charCreate height/volume/outfit): stored per character,
 * sent on charCreated / charList / worldEnter / spawn, and the starter kit follows the outfit choice. Synthetic
 * content fixtures (test/fixtures.ts) plus the light/heavy default sets.
 */
import { defaultLook, type CharLook, type ItemDef } from '@sro/shared'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openStore } from '../src/db.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ITEMS, LEVELS, contentFiles, item } from './fixtures.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'

const armour = (code: string, slot: ItemDef['slot'], gender: 'male' | 'female', armorType: ItemDef['armorType']) =>
  item(code, { category: 'armor', slot, armorType, degree: 1, reqLevel: 1, reqGender: gender, race: 'china', stats: { physDefence: [3, 3], magDefence: [1, 1] } })

/** The client's light (protector) and heavy (armour) default sets: body, legs, feet per gender. */
const OUTFITS: ItemDef[] = (['M', 'W'] as const).flatMap((g) =>
  (['LIGHT', 'HEAVY'] as const).flatMap((kind) =>
    ([['BA', 'chest'], ['LA', 'legs'], ['FA', 'feet']] as const).map(([part, slot]) =>
      armour(`ITEM_CH_${g}_${kind}_01_${part}_A_DEF`, slot, g === 'M' ? 'male' : 'female', kind === 'LIGHT' ? 'protector' : 'armor'),
    ),
  ),
)

let s: TestServer
let n = 0

beforeAll(async () => {
  s = await startTestServer({
    config: { tickHz: 20 },
    files: {
      'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: [50, 0, -50], bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
      ...contentFiles({ items: [...ITEMS, ...OUTFITS], levels: LEVELS }),
    },
  })
})

afterAll(async () => {
  await s.stopAndClean()
})

async function lobby() {
  const acc = await newAccount(s.url, 'look')
  return Client.login(s.url, acc.token)
}

describe('appearance', () => {
  it('charCreate stores height/volume/outfit; charCreated, charList, worldEnter and spawn carry them; the kit follows the outfit', async () => {
    const c = await lobby()
    const name = `Tall${++n}`
    c.send({ t: 'charCreate', name, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'spear', height: 4, volume: 0, outfit: 'heavy' })
    const created = (await c.next('charCreated')).character
    const heavy = { weapon: 'ITEM_CH_SPEAR_01_A_DEF', chest: 'ITEM_CH_W_HEAVY_01_BA_A_DEF', legs: 'ITEM_CH_W_HEAVY_01_LA_A_DEF', feet: 'ITEM_CH_W_HEAVY_01_FA_A_DEF' }
    expect(created).toMatchObject({ name, height: 4, volume: 0, equip: heavy })
    expect(s.ctx.store.characterById(created.id)).toMatchObject({ height: 4, volume: 0, outfit: 'heavy', starter_kit: 1 })

    c.send({ t: 'charList' })
    const listed = (await c.next('charList')).characters.find((ch) => ch.id === created.id)!
    expect(listed).toMatchObject({ height: 4, volume: 0, equip: heavy })

    c.send({ t: 'enterWorld', id: created.id })
    const e = await c.next('worldEnter')
    expect(e.self).toMatchObject({ height: 4, volume: 0, equip: heavy })
    const inv = (await c.next('inventory')).inventory
    expect(Object.fromEntries(Object.entries(inv.equip).map(([k, v]) => [k, v!.code]))).toEqual(heavy)

    // another player sees the same appearance in its spawn
    const d = await lobby()
    d.send({ t: 'charCreate', name: `Plain${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'bow', outfit: 'light' })
    const other = (await d.next('charCreated')).character
    expect(other).toMatchObject({ height: 2, volume: 2, equip: { weapon: 'ITEM_CH_BOW_01_A_DEF', chest: 'ITEM_CH_M_LIGHT_01_BA_A_DEF', legs: 'ITEM_CH_M_LIGHT_01_LA_A_DEF', feet: 'ITEM_CH_M_LIGHT_01_FA_A_DEF' } })
    d.send({ t: 'enterWorld', id: other.id })
    const de = await d.next('worldEnter')
    expect(de.entities.find((x) => x.id === e.self.id)).toMatchObject({ height: 4, volume: 0, equip: heavy })
    const seen = await c.next('spawn', (m) => m.entity.id === de.self.id)
    expect(seen.entity).toMatchObject({ height: 2, volume: 2, equip: { chest: 'ITEM_CH_M_LIGHT_01_BA_A_DEF' } })

    // an equipment change is announced as `appearance`
    d.send({ t: 'itemUnequip', slot: 'chest' })
    expect(await d.next('actionResult', (m) => m.re === 'itemUnequip')).toMatchObject({ ok: true })
    const look = await c.next('appearance', (m) => m.id === de.self.id)
    expect(look.equip.chest).toBeUndefined()
    expect(look.equip.weapon).toBe('ITEM_CH_BOW_01_A_DEF')
    c.close()
    d.close()
    await Promise.all([c.closed, d.closed])
  })

  it('defaults to height 2, volume 2 and the clothes set; out-of-range choices are rejected by the validator', async () => {
    const c = await lobby()
    c.send({ t: 'charCreate', name: `Mid${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    expect(ch).toMatchObject({ height: 2, volume: 2, equip: { weapon: 'ITEM_CH_BLADE_01_A_DEF', chest: 'ITEM_CH_M_CLOTHES_01_BA_A_DEF', legs: 'ITEM_CH_M_CLOTHES_01_LA_A_DEF', feet: 'ITEM_CH_M_CLOTHES_01_FA_A_DEF' } })
    expect(s.ctx.store.characterById(ch.id)).toMatchObject({ outfit: 'clothes' })
    for (const bad of [{ height: 5 }, { volume: -1 }, { height: 1.5 }, { outfit: 'robe' }, { height: '2' }]) {
      c.send({ t: 'charCreate', name: `Bad${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade', ...bad })
      expect(await c.next('error')).toMatchObject({ code: 'bad_request' })
    }
    c.send({ t: 'charList' })
    expect((await c.next('charList')).characters).toHaveLength(1)
    c.close()
    await c.closed
  })

  it("the look (§16.8): a default per body on create, the creator's look kept, sent to the owner and to everyone around", async () => {
    const c = await lobby()
    c.send({ t: 'charCreate', name: `Look${++n}`, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'sword', height: 3 })
    const plain = (await c.next('charCreated')).character
    expect(plain.look).toEqual({ ...defaultLook('f', plain.id), height: 3 })
    const mine: CharLook = { ...defaultLook('f'), outfit: '03', hair: '02', makeup: '27', iris: '12', hairColor: 9, skinTone: 4, skinShift: -20, markings: ['paint_teal'], accessories: ['earrings', 'nails'], height: 1, build: { ...defaultLook('f').build, chest: 90 } }
    c.send({ t: 'charCreate', name: `Made${++n}`, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'sword', look: mine })
    const made = (await c.next('charCreated')).character
    expect(made.look).toEqual(mine)
    expect(made.height).toBe(1)
    // a look of the other body, a version from the future, an unknown outfit are refused
    for (const bad of [{ ...mine, body: 'm' }, { ...mine, v: 2 }, { ...mine, outfit: '07' }, { ...mine, iris: '99' }, { ...mine, markings: ['A B'] }, { ...mine, makeup: '25' }, { ...mine, accessories: ['ring'] }]) {
      c.send({ t: 'charCreate', name: `Bad${++n}`, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'sword', look: bad as CharLook })
      expect(await c.next('error')).toMatchObject({ code: 'bad_request' })
    }
    // numbers out of range are clamped, not refused
    c.send({ t: 'charCreate', name: `Clamp${++n}`, model: 'CHAR_CH_WOMAN_ADVENTURER', weapon: 'sword', look: { ...mine, hairColor: 99, build: { ...mine.build, weight: 300 } } })
    expect((await c.next('charCreated')).character.look).toMatchObject({ hairColor: 31, build: { weight: 100 } })
    c.send({ t: 'enterWorld', id: made.id })
    const e = await c.next('worldEnter')
    expect(e.self.look).toEqual(mine)
    const d = await lobby()
    d.send({ t: 'charCreate', name: `Boy${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'bow' })
    const boy = (await d.next('charCreated')).character
    expect(boy.look?.body).toBe('m')
    d.send({ t: 'enterWorld', id: boy.id })
    const de = await d.next('worldEnter')
    expect(de.entities.find((x) => x.id === e.self.id)?.look).toEqual(mine)
    expect((await c.next('spawn', (m) => m.entity.id === de.self.id)).entity.look).toEqual(boy.look)
    c.close()
    d.close()
    await Promise.all([c.closed, d.closed])
  })
})

describe('migration 23: the look', () => {
  it("gives every existing character its body's default look (outfit from the id, Volume as Weight), the store reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), 'sro-m23-'))
    try {
      const raw = new Database(join(dir, 'game.db'))
      expect(migrate(raw, 22)).toBe(22)
      raw.prepare("INSERT INTO accounts (id, username, password_hash, created_at) VALUES (1, 'old', 'x', 0)").run()
      const add = raw.prepare("INSERT INTO characters (id, account_id, name, model, weapon, world, created_at, height, volume) VALUES (?, 1, ?, ?, 'sword', 'jangan', 0, ?, ?)")
      add.run(5, 'Girl', 'CHAR_CH_WOMAN_ADVENTURER', 2, 2)
      add.run(6, 'Boy', 'CHAR_CH_MAN_ADVENTURER', 4, 0)
      add.run(7, 'Euro', 'CHAR_EU_WOMAN_WARRIOR', 1, 4)
      raw.close()
      const store = openStore(dir)
      try {
        expect(store.schemaVersion).toBe(24)
        for (const [id, body, h, v] of [[5, 'f', 2, 2], [6, 'm', 4, 0], [7, 'f', 1, 4]] as const) {
          const row = store.characterById(id)!
          expect(JSON.parse(row.look!)).toEqual(defaultLook(body, id, h, v))
          expect(store.characterLook(row)).toEqual(defaultLook(body, id, h, v))
        }
        // garbage in the column reads as the default (never a crash, never a refused login)
        store.db.prepare("UPDATE characters SET look = '{bad' WHERE id = 6").run()
        expect(store.characterLook(store.characterById(6)!)).toEqual(defaultLook('m', 6, 4, 0))
      } finally {
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
