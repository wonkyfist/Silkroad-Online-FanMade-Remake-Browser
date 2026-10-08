import { describe, expect, it } from 'vitest'
import { LOOK_OUTFITS, defaultLook, lookBodyOf, lookOrDefault, parseLook, parseServerMessage, type CharLook } from '../src/index.ts'

describe('the character look (docs/CHARACTERS.md §16.8)', () => {
  it('defaults per body: outfit and hair from the seed, makeup / iris / build of the body, Volume as Weight', () => {
    expect(lookBodyOf('CHAR_CH_WOMAN_ADVENTURER')).toBe('f')
    expect(lookBodyOf('CHAR_EU_MAN_WARRIOR')).toBe('m')
    const outfits = new Set(Array.from({ length: 40 }, (_, i) => defaultLook('f', i * 2).outfit))
    expect([...outfits].sort()).toEqual([...LOOK_OUTFITS.f])
    expect(defaultLook('m', 4)).toMatchObject({ outfit: '03', hair: '03', makeup: '04', iris: '31', height: 2, build: { weight: 45, shoulders: 55 } })
    expect(defaultLook('f', 0, 3, 4)).toMatchObject({ height: 3, build: { weight: 70 } })
  })

  it('round-trips through JSON; clamps numbers, refuses wrong ids, versions and bodies', () => {
    const l: CharLook = { ...defaultLook('f', 1), hairColor: 5, markings: ['paint_red'], accessories: ['nails', 'nails'] }
    const back = parseLook(JSON.parse(JSON.stringify(l)))
    expect(back).toEqual({ ok: true, look: { ...l, accessories: ['nails'] } })
    expect(parseLook({ ...l, skinShift: -999, build: { muscle: 101.6 } })).toMatchObject({ ok: true, look: { skinShift: -50, build: { muscle: 100, weight: 40 } } })
    for (const bad of [null, 'x', [], { ...l, v: 2 }, { ...l, body: 'x' }, { ...l, outfit: '05' }, { ...l, hair: 1 }, { ...l, hair: '07' }, { ...l, makeup: '25' }, { ...l, markings: ['scar'] }, { ...l, markings: ['paint_red', 'paint_blue'] }, { ...l, accessories: ['ring'] }, { ...l, body: 'm', accessories: ['nails'] }, { ...l, makeup: 'red' }, { ...l, iris: '37' }, { ...l, markings: 'scar' }, { ...l, accessories: Array(7).fill('a') }, { ...l, hairColor: '3' }, { ...l, build: { weight: 'x' } }]) {
      expect(parseLook(bad).ok).toBe(false)
    }
    expect(parseLook(l, 'm')).toMatchObject({ ok: false })
    // a minimal record takes the body's defaults
    expect(parseLook({ v: 1, body: 'f' })).toEqual({ ok: true, look: defaultLook('f') })
  })

  it('reads stored JSON or falls back to the default', () => {
    expect(lookOrDefault(null, 'CHAR_CH_MAN_ADVENTURER', 2, 4)).toEqual(defaultLook('m', 2, 4))
    expect(lookOrDefault('{"v":1,"body":"f"}', 'CHAR_CH_MAN_ADVENTURER', 2)).toEqual(defaultLook('m', 2))
    expect(lookOrDefault('[', 'CHAR_CH_WOMAN_ADVENTURER', 3)).toEqual(defaultLook('f', 3))
  })

  it('travels on the wire additively: kept when valid, dropped (not the message) when not', () => {
    const look = defaultLook('f', 2)
    const ent = { id: 7, kind: 'player', name: 'A', model: 'CHAR_CH_WOMAN_ADVENTURER', level: 1, weapon: 'sword', pos: [0, 0, 0], yaw: 0 }
    const spawn = (e: object) => (parseServerMessage(JSON.stringify({ t: 'spawn', entity: e })) as { msg: { entity: { look?: CharLook } } }).msg
    expect(spawn({ ...ent, look }).entity.look).toEqual(look)
    expect(spawn({ ...ent, look: { ...look, v: 9 } }).entity.look).toBeUndefined()
    expect(spawn(ent).entity.look).toBeUndefined()
    const app = (parseServerMessage(JSON.stringify({ t: 'appearance', id: 7, equip: {}, look })) as { msg: { look?: CharLook } }).msg
    expect(app.look).toEqual(look)
  })
})
