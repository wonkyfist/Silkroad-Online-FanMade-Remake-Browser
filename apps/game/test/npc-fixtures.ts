/** Shared fixtures of the NPC-C tests (shop.test.ts, storage.test.ts): a logged-in ?mock=1 world with the NPC mock. */
import { parseClientMessage, type ClientMessage, type ServerMessage } from '@sro/shared'
import { MockServer, type KeyValueStore } from '../src/net/mock.ts'
import { npcMock } from '../src/net/mock/npc.ts'
import { Session } from '../src/net/session.ts'

function memory(): KeyValueStore {
  const m = new Map<string, string>()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))
}

/** A logged-in mock session in the world, with helpers that validate every frame sent. */
export async function mockWorld(name: string) {
  let now = 4_000_000_000
  const server = new MockServer(memory(), 0, () => now, [npcMock])
  await server.register({ username: name.toLowerCase(), password: 'secret' })
  const { token } = await server.login({ username: name.toLowerCase(), password: 'secret' })
  const s = new Session(() => server.wire(), token)
  const log: ServerMessage[] = []
  s.on(m => void log.push(m))
  await s.connect()
  const { character } = await s.request({ t: 'charCreate', name, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' }, ['charCreated'])
  const enter = await s.request({ t: 'enterWorld', id: character.id }, ['worldEnter'])
  await flush()
  const npc = enter.entities.find(e => e.kind === 'npc')!
  const send = async (msg: ClientMessage | null) => {
    if (!msg) throw new Error('no message')
    const parsed = parseClientMessage(JSON.stringify(msg))
    if (!parsed.ok) throw new Error(`invalid ${msg.t}: ${parsed.error}`)
    const from = log.length
    s.send(msg)
    await flush()
    return log.slice(from)
  }
  const step = async (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      now += 100
      server.step()
    }
    await flush()
  }
  const inventory = () => {
    const inv = [...log].reverse().find(m => m.t === 'inventory')
    return inv?.t === 'inventory' ? inv.inventory : null
  }
  return { server, s, log, enter, npc, send, step, inventory, close: () => (s.close(), server.dropAll()) }
}

export const of = <T extends ServerMessage['t']>(msgs: ServerMessage[], t: T) => msgs.filter(m => m.t === t) as Extract<ServerMessage, { t: T }>[]
