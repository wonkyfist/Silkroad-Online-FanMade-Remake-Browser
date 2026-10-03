// Character appearance through the mock server (?mock=1): the creation screen's request (buildCharCreate) with
// Height/Volume/outfit, the character list dressing, and the world snapshot carrying height/volume/equip.
import { describe, expect, it } from 'vitest'
import { buildCharCreate } from '@sro/appearance'
import type { ServerMessage } from '@sro/shared'
import { MockServer, type KeyValueStore } from '../src/net/mock.ts'
import { Session } from '../src/net/session.ts'

function memory(): KeyValueStore {
  const m = new Map<string, string>()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

function waitFor<T extends ServerMessage['t']>(s: Session, t: T, ms = 2000): Promise<Extract<ServerMessage, { t: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), ms)
    const off = s.on(msg => {
      if (msg.t === t) {
        clearTimeout(timer)
        off()
        resolve(msg as Extract<ServerMessage, { t: T }>)
      }
    })
  })
}

describe('mock server appearance', () => {
  it('keeps Height/Volume, wears the starter outfit and reports both in charList and worldEnter', async () => {
    const server = new MockServer(memory(), 0)
    await server.register({ username: 'dresser', password: 'secret' })
    const { token } = await server.login({ username: 'dresser', password: 'secret' })
    const s = new Session(() => server.wire(), token)
    await s.connect()
    const msg = buildCharCreate({ name: 'Tall_One', model: 'CHAR_CH_MAN_WARRIOR', weapon: 'sword', height: 4, volume: 1, outfit: 'heavy' })
    const { character } = await s.request(msg, ['charCreated'])
    expect(character).toMatchObject({ height: 4, volume: 1, weapon: 'sword' })
    // Builtin stand-in tables only have the garment set; the export has all three.
    expect(character.equip?.chest).toMatch(/^ITEM_CH_M_(HEAVY|CLOTHES)_01_BA_A_DEF$/)
    expect(character.equip?.legs).toMatch(/^ITEM_CH_M_(HEAVY|CLOTHES)_01_LA_A_DEF$/)
    expect(character.equip?.weapon).toBe('ITEM_CH_SWORD_01_A_DEF')

    const list = await s.request({ t: 'charList' }, ['charList'])
    expect(list.characters[0]).toMatchObject({ height: 4, volume: 1, equip: character.equip })

    const enter = waitFor(s, 'worldEnter')
    s.send({ t: 'enterWorld', id: character.id })
    const w = await enter
    expect(w.self).toMatchObject({ height: 4, volume: 1, equip: character.equip })
    const bots = w.entities.filter(e => e.kind === 'player')
    expect(bots.length).toBeGreaterThan(0)
    for (const b of bots) {
      expect(b.equip?.chest).toMatch(/_01_BA_A_DEF$/)
      expect(typeof b.height).toBe('number')
    }
    s.close()
  })

  it('an old-style charCreate (no appearance fields) gets the defaults', async () => {
    const server = new MockServer(memory(), 0)
    await server.register({ username: 'plain', password: 'secret' })
    const { token } = await server.login({ username: 'plain', password: 'secret' })
    const s = new Session(() => server.wire(), token)
    await s.connect()
    const { character } = await s.request({ t: 'charCreate', name: 'Plain', model: 'CHAR_CH_WOMAN_FOX', weapon: 'bow' }, ['charCreated'])
    expect(character).toMatchObject({ height: 2, volume: 2 })
    expect(character.equip?.chest).toBe('ITEM_CH_W_CLOTHES_01_BA_A_DEF')
    s.close()
  })
})
