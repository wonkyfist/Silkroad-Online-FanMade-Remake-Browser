/**
 * Character appearance (docs/CHARACTER_SCALE.md, protocol charCreate height/volume/outfit): stored per character,
 * sent on charCreated / charList / worldEnter / spawn, and the starter kit follows the outfit choice. Synthetic
 * content fixtures (test/fixtures.ts) plus the light/heavy default sets.
 */
import type { ItemDef } from '@sro/shared'
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
})
