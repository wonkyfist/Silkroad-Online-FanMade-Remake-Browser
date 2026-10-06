/**
 * Siege of Jangan, layer 5 (docs/SIEGE.md §7, §8, §10): the wire messages of player kegs and Wanted, the content install.
 */
import { describe, expect, it } from 'vitest'
import {
  ACTION_FAIL_REASONS,
  GAMEPLAY_REQUESTS,
  LAW_CODES,
  NPC_SERVICES,
  SALTPETER_DROP,
  installSiegeLawContent,
  parseClientMessage,
  parseServerMessage,
  type DropTable,
  type ItemDef,
  type NpcDef,
} from '../src/index.ts'

describe('wire messages (protocol v1, additive)', () => {
  const client = (m: unknown) => parseClientMessage(JSON.stringify(m))
  const server = (m: unknown) => parseServerMessage(JSON.stringify(m))

  it('kegCraft is a gameplay request; keg_limit a refusal; fence an NPC service', () => {
    expect(GAMEPLAY_REQUESTS).toContain('kegCraft')
    expect(ACTION_FAIL_REASONS).toContain('keg_limit')
    expect(NPC_SERVICES).toContain('fence')
    expect(client({ t: 'kegCraft', npc: 7 })).toEqual({ ok: true, msg: { t: 'kegCraft', npc: 7 } })
    expect(client({ t: 'kegCraft' }).ok).toBe(false)
    expect(client({ t: 'kegCraft', npc: 7, gold: 1 }).ok).toBe(false)
  })

  it('lawNotice and lawState parse; bad ones are refused', () => {
    const wanted = { t: 'lawNotice', event: 'wanted', wall: 'W3', name: 'Aki', bounty: 40_000, treason: true, accomplices: ['Mei'] }
    expect(server(wanted)).toEqual({ ok: true, msg: wanted })
    expect(server({ t: 'lawNotice', event: 'plant', wall: 'S9' })).toEqual({ ok: true, msg: { t: 'lawNotice', event: 'plant', wall: 'S9' } })
    expect(server({ t: 'lawNotice', event: 'boom' }).ok).toBe(false)
    expect(server({ t: 'lawNotice', event: 'plant', wall: 'X1' }).ok).toBe(false)
    const state = { t: 'lawState', offences: 2, wanted: { bounty: 20_000, lapseMs: 3_600_000, offence: 2, role: 'accomplice' } }
    expect(server(state)).toEqual({ ok: true, msg: state })
    expect(server({ t: 'lawState', offences: 0 })).toEqual({ ok: true, msg: { t: 'lawState', offences: 0 } })
    expect(server({ t: 'lawState', offences: 1, wanted: { bounty: -1, lapseMs: 0, offence: 1, role: 'breaker' } }).ok).toBe(false)
  })

  it('the WANTED bounty on a spawn and an entityUpdate (0 clears it)', () => {
    const spawn = server({ t: 'spawn', entity: { id: 4, kind: 'player', name: 'Aki', model: 'CHAR_CH_MAN_ADVENTURER', level: 20, pos: [0, 0, 0], yaw: 0, weapon: 'sword', wanted: 20_000 } })
    expect(spawn.ok && spawn.msg.t === 'spawn' && spawn.msg.entity.wanted).toBe(20_000)
    expect(server({ t: 'entityUpdate', id: 4, wanted: 0 })).toEqual({ ok: true, msg: { t: 'entityUpdate', id: 4, wanted: 0 } })
    expect(server({ t: 'entityUpdate', id: 4, wanted: -5 }).ok).toBe(false)
  })
})

describe('content', () => {
  it('installs the keg, Saltpeter, Old Fang and the Bandits’ Saltpeter drops once', () => {
    const items = new Map<string, ItemDef>()
    const drops = new Map<string, DropTable>([['MOB_CH_BANDIT', { mob: 'MOB_CH_BANDIT', groups: [], provenance: 'client' }]])
    const npcs: NpcDef[] = []
    expect(installSiegeLawContent({ items, drops, npcs }, 'jangan')).toEqual({ items: 2, npc: true, drops: 1 })
    expect(installSiegeLawContent({ items, drops, npcs }, 'jangan')).toEqual({ items: 0, npc: false, drops: 0 })
    expect(items.has(LAW_CODES.keg) && items.has(LAW_CODES.saltpeter)).toBe(true)
    expect(npcs.map((n) => n.code)).toEqual([LAW_CODES.fence])
    expect(drops.get('MOB_CH_BANDIT')!.groups).toEqual([{ chance: SALTPETER_DROP, entries: [{ item: LAW_CODES.saltpeter, weight: 1 }] }])
  })
})
