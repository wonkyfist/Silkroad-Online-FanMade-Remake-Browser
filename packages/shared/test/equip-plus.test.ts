/**
 * The weapon glow's protocol addition (packages/shared/src/protocol.ts): the +N of a player's visible items travels
 * as EntityState.equipPlus (spawn, worldEnter), CharacterSummary.equipPlus (charList: the select stage) and the
 * appearance message's `plus`, so other players see the glow. Additive and optional: absent = all +0, older messages
 * parse as before, +0 entries are dropped, out-of-range values are rejected.
 */
import { describe, expect, it } from 'vitest'
import { parseServerMessage, type CharacterSummary, type EntityState, type ServerMessage } from '../src/index.ts'

const player: EntityState = { id: 5, kind: 'player', name: 'Glow', model: 'CHAR_CH_MAN_ADVENTURER', level: 12, weapon: 'blade', pos: [1, 2, 3], yaw: 0, equip: { weapon: 'ITEM_CH_BLADE_01_A', shield: 'ITEM_CH_SHIELD_01_A' } }
const summary: CharacterSummary = { id: 3, name: 'Glow', model: 'CHAR_CH_MAN_ADVENTURER', level: 12, weapon: 'blade', location: 'Jangan', pos: [0, 0, 0], lastPlayed: 0, equip: { weapon: 'ITEM_CH_BLADE_01_A' } }

const parse = (m: unknown) => parseServerMessage(JSON.stringify(m))

describe('equipPlus on the wire', () => {
  it('spawn, charList and appearance carry the +N of the visible slots', () => {
    const good: ServerMessage[] = [
      { t: 'spawn', entity: { ...player, equipPlus: { weapon: 7, shield: 3 } } },
      { t: 'charList', slots: 4, characters: [{ ...summary, equipPlus: { weapon: 5 } }] },
      { t: 'appearance', id: 5, equip: { weapon: 'ITEM_CH_BLADE_01_A' }, plus: { weapon: 7 } },
      { t: 'appearance', id: 5, equip: { weapon: 'ITEM_CH_BLADE_01_A' }, plus: { weapon: 12, chest: 255 } },
    ]
    for (const m of good) expect(parse(m), m.t).toEqual({ ok: true, msg: m })
  })

  it('stays optional: messages without it parse as before (all +0)', () => {
    const old: ServerMessage[] = [
      { t: 'spawn', entity: player },
      { t: 'charList', slots: 4, characters: [summary] },
      { t: 'appearance', id: 5, equip: { weapon: 'ITEM_CH_BLADE_01_A' } },
    ]
    for (const m of old) {
      const r = parse(m)
      expect(r, m.t).toEqual({ ok: true, msg: m })
    }
    const spawn = parse({ t: 'spawn', entity: player })
    expect(spawn.ok && spawn.msg.t === 'spawn' && spawn.msg.entity.equipPlus).toBe(undefined)
  })

  it('drops +0 entries and unknown slots; rejects a +N out of 0..255 or not an integer', () => {
    const r = parse({ t: 'appearance', id: 5, equip: {}, plus: { weapon: 0, shield: 4, cape: 9 } })
    expect(r).toEqual({ ok: true, msg: { t: 'appearance', id: 5, equip: {}, plus: { shield: 4 } } })
    for (const bad of [{ weapon: 256 }, { weapon: -1 }, { weapon: 2.5 }, { weapon: '7' }, 7, [7]]) {
      expect(parse({ t: 'appearance', id: 5, equip: {}, plus: bad }).ok, JSON.stringify(bad)).toBe(false)
      expect(parse({ t: 'spawn', entity: { ...player, equipPlus: bad } }).ok, JSON.stringify(bad)).toBe(false)
    }
  })
})
