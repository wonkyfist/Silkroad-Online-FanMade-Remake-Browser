/**
 * The weapon glow's protocol addition on the server (world.ts visibleEquipPlus, gameplay.ts afterInventory,
 * connection.ts summary): the +N of a player's visible items reaches the other players (spawn and worldEnter
 * EntityState.equipPlus, an `appearance` with `plus` when only the +N changes: alchemy or GM `plus`), the player itself
 * (its own appearance) and the character list (CharacterSummary.equipPlus, the select stage). +0 is left out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ITEMS, LEVELS, contentFiles } from './fixtures.ts'
import { Client, newAccount, startTestServer, type TestServer } from './helpers.ts'
import { visibleEquipPlus } from '../src/world.ts'

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

async function enter(weapon: 'sword' | 'blade') {
  const acc = await newAccount(s.url, 'glow')
  const c = await Client.login(s.url, acc.token)
  c.send({ t: 'charCreate', name: `Glow${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon })
  const character = (await c.next('charCreated')).character
  c.send({ t: 'enterWorld', id: character.id })
  const w = await c.next('worldEnter')
  const player = [...s.ctx.world.players.values()].find(p => p.id === w.self.id)!
  return { c, acc, character, self: w.self, player, entities: w.entities }
}

/** How `viewer` first saw `id`: in its worldEnter, else in a spawn. */
async function seenBy(viewer: Awaited<ReturnType<typeof enter>>, id: number) {
  return viewer.entities.find(e => e.id === id) ?? (await viewer.c.next('spawn', m => m.entity.id === id)).entity
}

describe('visibleEquipPlus', () => {
  it('keeps the visible slots with a +N above 0', () => {
    expect(visibleEquipPlus({ weapon: { code: 'W', count: 1, plus: 7 }, shield: { code: 'S', count: 1, plus: 0 }, chest: { code: 'C', count: 1 }, ring1: { code: 'R', count: 1, plus: 5 } })).toEqual({ weapon: 7 })
    expect(visibleEquipPlus({})).toEqual({})
  })
})

describe('the +N reaches other players', () => {
  it('a +N change alone is announced as appearance with plus; spawn, worldEnter and charList carry equipPlus', async () => {
    const a = await enter('sword')
    const b = await enter('blade')
    // b sees a at +0: no equipPlus.
    const aAtB = await seenBy(b, a.self.id)
    expect(aAtB.equip).toEqual(a.self.equip)
    expect(aAtB.equipPlus).toBeUndefined()

    // GM `plus weapon 7` (the alchemy path's afterInventory): a and b both get the appearance, codes unchanged.
    expect(s.ctx.gameplay.alchemy.gm(a.player, ['weapon', '7'])).toMatchObject({ ok: true })
    const atB = await b.c.next('appearance', m => m.id === a.self.id)
    expect(atB).toEqual({ t: 'appearance', id: a.self.id, equip: a.self.equip, plus: { weapon: 7 } })
    const atA = await a.c.next('appearance', m => m.id === a.self.id)
    expect(atA.plus).toEqual({ weapon: 7 })

    // Back to +0: an appearance without plus.
    expect(s.ctx.gameplay.alchemy.gm(a.player, ['weapon', '0'])).toMatchObject({ ok: true })
    const zero = await b.c.next('appearance', m => m.id === a.self.id)
    expect(zero.plus).toBeUndefined()
    expect(zero.equip).toEqual(a.self.equip)

    // A late joiner sees it in worldEnter; the owner's character list carries it for the select stage.
    expect(s.ctx.gameplay.alchemy.gm(a.player, ['weapon', '5'])).toMatchObject({ ok: true })
    await b.c.next('appearance', m => m.id === a.self.id)
    const late = await enter('blade')
    expect((await seenBy(late, a.self.id)).equipPlus).toEqual({ weapon: 5 })
    // a sees itself at +5 when it enters again too (worldEnter.self).
    expect(a.player.equip.weapon?.plus).toBe(5)
    a.c.send({ t: 'charList' })
    const list = await a.c.next('charList')
    expect(list.characters.find(ch => ch.id === a.character.id)?.equipPlus).toEqual({ weapon: 5 })
    // A setting of the same +N again is no news.
    expect(s.ctx.gameplay.alchemy.gm(a.player, ['weapon', '5'])).toMatchObject({ ok: true })
    await expect(b.c.next('appearance', m => m.id === a.self.id, 600)).rejects.toThrow()
    for (const x of [a, b, late]) x.c.close()
  })
})
