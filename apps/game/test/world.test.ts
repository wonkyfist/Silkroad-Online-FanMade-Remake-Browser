import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseClientMessage, parseServerMessage, type ClientMessage, type EntityState, type ServerMessage } from '@sro/shared'
import { Catalog, contentCodeFromIndexId, contentModelsFromIndex, weaponFamilyOf } from '../src/content/catalog.ts'
import { builtinTables, expToNext, mergeTables } from '../src/content/gameplay.ts'
import { MockServer, type KeyValueStore } from '../src/net/mock.ts'
import { addToBag, deriveStats, emptyInventory, rng, rollDrops, starterProgress } from '../src/net/mock-rules.ts'
import { Session } from '../src/net/session.ts'
import { intents } from '../src/world/intents.ts'

function memory(): KeyValueStore {
  const m = new Map<string, string>()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))
}

describe('world intents', () => {
  it('every message the world code sends passes the shared client validator', () => {
    const built: ClientMessage[] = [
      intents.moveTo(12.3456, -7.891),
      intents.moveTo(Number.NaN, Infinity),
      intents.moveTo(5e9, -5e9),
      intents.attack(101),
      intents.attack(101.7),
      intents.attack(-3),
      intents.pickup(250),
      intents.stopAction(),
      intents.respawn(),
      intents.chat('hello'),
      intents.enterWorld(1),
      intents.leaveWorld(),
    ]
    for (const msg of built) {
      const r = parseClientMessage(JSON.stringify(msg))
      expect(r.ok, `${msg.t}: ${r.ok ? '' : r.error}`).toBe(true)
    }
  })

  it('the world screen sends only through the validated intent path', () => {
    const src = readFileSync(new URL('../src/screens/world.ts', import.meta.url), 'utf8')
    expect(src.match(/session\.send\(/g)?.length).toBe(1)
    for (const m of src.matchAll(/\bsend\(([^)]*)\)/g)) {
      const arg = m[1]!.trim()
      if (arg === 'msg' || arg.startsWith('msg:') || arg === '') continue
      expect(arg, m[0]).toMatch(/^intents\.|^gm\./)
    }
  })
})

describe('gameplay content', () => {
  it('maps converter ids of mobs and NPCs to CodeName128', () => {
    expect(contentCodeFromIndexId('mob/china/mangnyang')).toBe('MOB_CH_MANGNYANG')
    expect(contentCodeFromIndexId('mob/china/tigerwoman')).toBe('MOB_CH_TIGERWOMAN')
    expect(contentCodeFromIndexId('npc/china/potion')).toBe('NPC_CH_POTION')
    expect(contentCodeFromIndexId('char/china/chinaman_adventurer')).toBeUndefined()
    expect(weaponFamilyOf('ITEM_CH_TBLADE_01_A_DEF')).toBe('glaive')
    expect(weaponFamilyOf('ITEM_ETC_HP_POTION_01')).toBeUndefined()
  })

  it('resolves mob visuals from the builtin data and the converter index', () => {
    const models = contentModelsFromIndex([{ id: 'mob/china/mangnyang', category: 'mob/china', glb: 'mob/china/mangnyang.glb', sidecar: 'mob/china/mangnyang.json' }])
    const catalog = new Catalog([], {}, 'test', builtinTables(), models)
    const m = catalog.mob('MOB_CH_MANGNYANG')
    expect(m).toMatchObject({ name: 'Mangnyang', level: 1, scale: 1, model: { glb: '/out/mob/china/mangnyang.glb', sidecar: '/out/mob/china/mangnyang.json' } })
    expect(catalog.mob('MOB_CH_TIGER').model).toBeUndefined()
    expect(catalog.itemName('ITEM_ETC_HP_POTION_01')).toBe('HP Recovery Herb')
  })

  it('merges exported files over the builtin stand-ins', () => {
    const merged = mergeTables(builtinTables(), {
      mobs: { schema: 1, kind: 'mobs', generatedAt: '', sources: [], entries: [{ ...builtinTables().mobs.get('MOB_CH_TIGER')!, level: 11 }] },
      levels: [{ level: 1, exp: 118, masterySp: 1 }, { level: 2, exp: 470, masterySp: 1 }],
      items: { schema: 1, kind: 'mobs', entries: [] },
    })
    expect(merged.mobs.get('MOB_CH_TIGER')!.level).toBe(11)
    expect(merged.mobs.get('MOB_CH_MANGNYANG')!.level).toBe(1)
    expect(expToNext(merged, 1, 20)).toBe(118)
    expect(expToNext(merged, 20, 20)).toBe(0)
    expect(merged.exported).toEqual(['mobs', 'levels'])
  })
})

describe('mock rules', () => {
  const tables = builtinTables()

  it('adds to the bag all-or-nothing, merging stacks first', () => {
    const inv = emptyInventory()
    inv.bagSize = 2
    inv.bag = [{ code: 'ITEM_ETC_HP_POTION_01', count: 45 }, null]
    const def = tables.items.get('ITEM_ETC_HP_POTION_01')
    expect(addToBag(inv, def, 'ITEM_ETC_HP_POTION_01', 10)).toEqual([
      { slot: 0, item: { code: 'ITEM_ETC_HP_POTION_01', count: 50 } },
      { slot: 1, item: { code: 'ITEM_ETC_HP_POTION_01', count: 5 } },
    ])
    expect(addToBag(inv, def, 'ITEM_ETC_HP_POTION_01', 100)).toBeNull()
    expect(inv.bag[1]).toEqual({ code: 'ITEM_ETC_HP_POTION_01', count: 5 })
  })

  it('starts characters with their weapon, potions and full HP; rolls loot deterministically', () => {
    const p = starterProgress('spear', false, 1, tables)
    expect(p.inventory.equip.weapon?.code).toBe('ITEM_CH_SPEAR_01_A_DEF')
    const s = deriveStats(p, tables)
    expect(s.maxHp).toBe(200)
    expect(p.hp).toBe(s.maxHp)
    expect(s.expToNext).toBeGreaterThan(0)
    const a = rollDrops(tables.drops.get('MOB_CH_TIGER'), rng(7), tables)
    const b = rollDrops(tables.drops.get('MOB_CH_TIGER'), rng(7), tables)
    expect(a).toEqual(b)
  })
})

describe('mock gameplay (?mock=1)', () => {
  it('plays combat, loot, inventory, levels, shop, death and respawn with valid messages', async () => {
    let now = 1_000_000_000
    const server = new MockServer(memory(), 0, () => now)
    server.gmRole = 'admin'
    await server.register({ username: 'fighter', password: 'secret' })
    const { token } = await server.login({ username: 'fighter', password: 'secret' })
    const sent: ClientMessage[] = []
    const s = new Session(() => {
      const w = server.wire()
      const inner = w.send.bind(w)
      w.send = msg => {
        sent.push(msg)
        inner(msg)
      }
      return w
    }, token)
    const log: ServerMessage[] = []
    s.on(m => log.push(m))
    await s.connect()
    const { character } = await s.request({ t: 'charCreate', name: 'Fighter', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' }, ['charCreated'])

    const send = async (msg: ClientMessage) => {
      s.send(msg)
      await flush()
    }
    const find = <T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, from = 0) =>
      log.slice(from).find(m => m.t === t && pred(m as Extract<ServerMessage, { t: T }>)) as Extract<ServerMessage, { t: T }> | undefined
    const until = async <T>(get: () => T | undefined, what: string, steps = 3000): Promise<T> => {
      for (let i = 0; i < steps; i++) {
        const v = get()
        if (v !== undefined) return v
        now += 100
        server.step()
        await flush()
      }
      throw new Error(`timed out: ${what}`)
    }
    const result = async (msg: ClientMessage) => {
      const from = log.length
      await send(msg)
      return until(() => find('actionResult', m => m.re === msg.t, from), `actionResult ${msg.t}`)
    }
    const gmRun = async (cmd: string, ...args: string[]) => {
      const from = log.length
      await send({ t: 'gm', cmd, args })
      return until(() => find('gmResult', m => m.cmd === cmd, from), `gm ${cmd}`)
    }

    await send(intents.enterWorld(character.id))
    const enter = await until(() => find('worldEnter'), 'worldEnter')
    const me = enter.self.id
    const order = log.map(m => m.t).filter(t => t === 'worldEnter' || t === 'stats' || t === 'inventory')
    expect(order.slice(0, 3)).toEqual(['worldEnter', 'stats', 'inventory'])
    expect(enter.self).toMatchObject({ kind: 'player', hp: 200, maxHp: 200, equip: { weapon: 'ITEM_CH_BLADE_01_A_DEF' } })
    const kinds = new Set(enter.entities.map((e: EntityState) => e.kind))
    expect(kinds).toEqual(new Set(['player', 'mob', 'npc']))
    expect(enter.entities.filter(e => e.kind === 'mob').map(e => e.model)).toEqual(expect.arrayContaining(['MOB_CH_MANGNYANG', 'MOB_CH_TIGER']))
    const inventory = find('inventory')!.inventory
    expect(inventory.bag[0]).toMatchObject({ code: 'ITEM_ETC_HP_POTION_01', count: 20 })

    // Fight: spawn a Mangnyang next to us, attack, the server walks in and swings until it dies.
    const spawned = await gmRun('spawn', 'MOB_CH_MANGNYANG')
    const mobId = (spawned.data as { ids: number[] }).ids[0]!
    expect((await result(intents.attack(mobId))).ok).toBe(true)
    const kill = await until(() => find('combat', m => m.target === mobId && !!m.killed), 'kill')
    expect(kill.attacker).toBe(me)
    expect(find('entityUpdate', m => m.id === mobId && m.state === 'dead')).toBeDefined()
    expect(find('statsDelta', m => m.gain?.from === mobId)?.gain?.exp).toBe(26)
    await until(() => find('despawn', m => m.id === mobId), 'corpse despawn')
    expect((await result(intents.attack(mobId))).reason).toBe('not_found')

    // Loot: drop two potions and pick them up again.
    expect((await result({ t: 'itemDrop', bag: 0, count: 2 })).ok).toBe(true)
    const dropped = await until(() => find('spawn', m => m.entity.kind === 'item' && m.entity.model === 'ITEM_ETC_HP_POTION_01'), 'dropped item')
    expect(dropped.entity).toMatchObject({ count: 2 })
    expect(dropped.entity.owner).toBeUndefined()
    const picked = await result(intents.pickup(dropped.entity.id))
    expect(picked.ok).toBe(true)
    expect(find('despawn', m => m.id === dropped.entity.id)).toBeDefined()

    // Inventory requests.
    expect((await result({ t: 'itemEquip', bag: 3 })).ok).toBe(true) // robe -> chest
    expect(find('appearance', m => m.id === me && m.equip.chest === 'ITEM_CH_M_CLOTHES_01_BA_A_DEF')).toBeDefined()
    expect((await result({ t: 'itemEquip', bag: 5 })).ok).toBe(true) // sword swaps with the blade
    expect(find('appearance', m => m.id === me && m.equip.weapon === 'ITEM_CH_SWORD_01_A_DEF')).toBeDefined()
    expect((await result({ t: 'itemEquip', bag: 6 })).ok).toBe(true) // shield with a one-handed sword
    expect((await result({ t: 'itemUnequip', slot: 'shield' })).ok).toBe(true)
    expect((await result({ t: 'itemEquip', bag: 4, slot: 'head' })).reason).toBe('invalid_slot')
    expect((await result({ t: 'itemMove', from: 0, to: 20 })).ok).toBe(true)
    expect((await result({ t: 'itemSplit', from: 20, to: 21, count: 5 })).ok).toBe(true)
    expect((await result({ t: 'itemSplit', from: 20, to: 22, count: 500 })).reason).toBe('invalid_count')
    expect((await result({ t: 'itemUse', bag: 21 })).ok).toBe(true)
    // Wave 7B: the drinker (and viewers) see the potion's effect (I7B mock, as apps/server/src/item-use.ts does).
    expect(await until(() => find('itemEffect', m => m.id === me), 'itemEffect')).toEqual({ t: 'itemEffect', id: me, item: 'ITEM_ETC_HP_POTION_01' })
    expect((await result({ t: 'itemUse', bag: 21 })).reason).toBe('cooldown')
    expect((await result({ t: 'itemUse', bag: 30 })).reason).toBe('invalid_slot')
    expect((await result({ t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01' })).reason).toBe('not_found') // no skills.json in this mock's content: an unknown skill

    // Levels and stat points.
    expect((await result({ t: 'statUp', stat: 'str', points: 1 })).reason).toBe('no_points')
    expect((await gmRun('setlevel', 'Fighter', '5')).ok).toBe(true)
    expect(find('levelUp', m => m.id === me && m.level === 5)).toBeDefined()
    expect((await result({ t: 'statUp', stat: 'str', points: 3 })).ok).toBe(true)
    const statsAfter = [...log].reverse().find(m => m.t === 'stats') as Extract<ServerMessage, { t: 'stats' }>
    expect(statsAfter.stats).toMatchObject({ level: 5, str: 27, statPoints: 9 })

    // Shop (the potion merchant stands next to the spawn).
    await gmRun('tp', '2', '2')
    const npc = enter.entities.find(e => e.kind === 'npc')!
    expect((await result({ t: 'shopBuy', npc: npc.id, item: 'ITEM_ETC_HP_POTION_01', count: 5 })).ok).toBe(true)
    expect((await result({ t: 'shopBuy', npc: npc.id, item: 'ITEM_CH_SWORD_01_A', count: 1 })).reason).toBe('not_found')
    expect((await result({ t: 'shopSell', npc: npc.id, bag: 1, count: 1 })).ok).toBe(true)
    await gmRun('tp', '200', '200')
    expect((await result({ t: 'shopSell', npc: npc.id, bag: 1, count: 1 })).reason).toBe('too_far')

    // GM item / kill / heal.
    expect((await gmRun('item', 'ITEM_ETC_GOLD_01', '500')).ok).toBe(true)
    expect((await gmRun('item', 'ITEM_CH_RING_01_A_DEF', '1')).ok).toBe(true)
    expect((await gmRun('item', 'ITEM_NOPE')).ok).toBe(false)
    const victim = (await gmRun('spawn', 'mob_ch_mangnyang', '2')).data as { ids: number[] }
    expect((await gmRun('kill', String(victim.ids[0]))).ok).toBe(true)
    expect(find('entityUpdate', m => m.id === victim.ids[0] && m.state === 'dead')).toBeDefined()

    // Death: a pack of Tiger Girls kills us; respawn in town.
    await gmRun('spawn', 'MOB_CH_TIGERWOMAN', '3')
    await until(() => find('entityUpdate', m => m.id === me && m.state === 'dead'), 'player death', 6000)
    expect((await result(intents.attack(victim.ids[1]!))).reason).toBe('dead')
    const from = log.length
    expect((await result(intents.respawn())).ok).toBe(true)
    expect(find('warp', m => m.id === me, from)!.pos[0]).toBeLessThan(3)
    expect(find('entityUpdate', m => m.id === me && m.state === 'alive', from)).toBeDefined()
    expect(find('stats', () => true, from)!.stats.hp).toBeGreaterThan(0)
    expect((await result(intents.respawn())).reason).toBe('not_dead')
    expect((await gmRun('heal')).ok).toBe(true)

    // Every server frame the mock produced is valid protocol, and so is every client frame sent.
    for (const m of log) {
      const r = parseServerMessage(JSON.stringify(m))
      expect(r.ok, `${m.t}: ${r.ok ? '' : r.error}`).toBe(true)
    }
    const seen = new Set(log.map(m => m.t))
    for (const t of ['actionResult', 'combat', 'stats', 'statsDelta', 'levelUp', 'inventory', 'inventoryUpdate', 'appearance', 'entityUpdate', 'spawn', 'despawn', 'warp'] as const) {
      expect(seen.has(t), t).toBe(true)
    }
    for (const m of sent) {
      const r = parseClientMessage(JSON.stringify(m))
      expect(r.ok, `${m.t}: ${r.ok ? '' : r.error}`).toBe(true)
    }
    s.close()
  })
})
