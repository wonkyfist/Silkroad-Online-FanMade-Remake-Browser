/**
 * A synthetic world for the NPC, shop and consumable tests (lane NPC-S): a flat 1 km world, the shared fixtures'
 * items plus a few of our own, four shop NPCs, a storage keeper pair (one hidden), a quest-style NPC with no services,
 * and a controllable clock driven through World.tick. Numbers are made up, not retail.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GameplayRequest, ItemDef, NpcDef, ServerMessage, ShopDef, Vec3 } from '@sro/shared'
import type { ServerConfig } from '../src/config.ts'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay, type GameplayMessage } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import type { InvDraft, InvItem } from '../src/inventory.ts'
import { FlatNav } from '../src/nav.ts'
import { World, type MoveValidator, type Player } from '../src/world.ts'
import { ITEMS, LEVELS, MANGNYANG, item, seeded } from './fixtures.ts'
import { testConfig } from './helpers.ts'

export type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

export const RETURN_01 = item('ITEM_ETC_SCROLL_RETURN_01', { category: 'scroll', maxStack: 50, price: 5000, sellPrice: 1500, use: { returnToTown: true, castMs: 30_000 } })
export const RETURN_03 = item('ITEM_ETC_SCROLL_RETURN_03', { category: 'scroll', maxStack: 50, price: 15000, sellPrice: 4500, use: { returnToTown: true, castMs: 5000 } })
/** A return item without a cast time (works at once). */
export const RETURN_NOW = item('ITEM_ETC_SCROLL_RETURN_NOW', { category: 'scroll', maxStack: 50, use: { returnToTown: true } })
export const MP_POTION = item('ITEM_ETC_MP_POTION_01', { category: 'potion', maxStack: 50, price: 20, sellPrice: 5, use: { mp: 100, cooldownGroup: 'mp', cooldownMs: 1000 } })
export const HP_GRAIN = item('ITEM_ETC_HP_SPOTION_01', { category: 'potion', maxStack: 50, price: 600, sellPrice: 210, use: { hpPct: 25, cooldownGroup: 'hp', cooldownMs: 1000 } })
export const PILL = item('ITEM_ETC_CURE_ALL_01', { category: 'pill', maxStack: 50, price: 36, sellPrice: 17, cureLevel: 36, use: { cooldownGroup: 'cure', cooldownMs: 1000 } })
/** Needs level 21: above the default cap of 20 (like the degree-3 chests, docs/SHOPS.md §2.4). */
export const CHEST_21 = item('ITEM_CH_M_HEAVY_03_BA_A', { category: 'armor', slot: 'chest', reqLevel: 21, reqGender: 'male', price: 22750, sellPrice: 8190 })
export const CHEST_19 = item('ITEM_CH_M_HEAVY_03_CA_A', { category: 'armor', slot: 'head', reqLevel: 19, reqGender: 'male', price: 12250, sellPrice: 4410 })
export const NO_SELL = item('ITEM_ETC_NOSELL', { category: 'etc', canSell: false })
export const ARROWS = item('ITEM_ETC_AMMO_ARROW_01', { category: 'ammo', maxStack: 250, price: 2, sellPrice: 1 })

export const NPC_ITEMS: ItemDef[] = [...ITEMS, RETURN_01, RETURN_03, RETURN_NOW, MP_POTION, HP_GRAIN, PILL, CHEST_21, CHEST_19, NO_SELL, ARROWS]

const npc = (code: string, x: number, z: number, over: Partial<NpcDef> = {}): NpcDef => ({ code, name: code, x, z, yaw: 0, world: 'jangan', model: null, provenance: 'client', ...over })

/** Positions (x, z): the potion merchant at the origin's east, the others spread out so their 8 m rings never overlap. */
export const NPC_DEFS: NpcDef[] = [
  npc('NPC_CH_POTION', 20, 0, { shop: 'STORE_CH_POTION', greeting: 'With consistent patients...' }),
  npc('NPC_CH_ARMOR', 20, 40, { shop: 'STORE_CH_ARMOR' }),
  npc('NPC_CH_ACCESSORY', 60, 0, { shop: 'STORE_CH_ACCESSORY' }),
  npc('NPC_CH_CAPPED', 60, 40, { shop: 'STORE_CH_CAPPED' }),
  npc('NPC_CH_WAREHOUSE_W', -40, 0, { roles: ['storage'] }),
  npc('NPC_CH_WAREHOUSE_M', -40, 0.05, { roles: ['storage'] }),
  npc('NPC_CH_CHEF', -40, 40),
  npc('NPC_CH_ELSEWHERE', 20, 0, { world: 'donwhang', shop: 'STORE_CH_POTION' }),
]

export const SHOP_DEFS: ShopDef[] = [
  { id: 'STORE_CH_POTION', npcs: ['NPC_CH_POTION'], tabs: [{ name: 'Potion', items: ['ITEM_ETC_HP_POTION_01', MP_POTION.code, PILL.code, 'ITEM_CH_BLADE_02_A', ARROWS.code] }], provenance: 'client' },
  {
    id: 'STORE_CH_ARMOR',
    npcs: ['NPC_CH_ARMOR'],
    tabs: [{ name: 'Armor', items: [CHEST_19.code, CHEST_21.code], reqGender: 'male' }],
    provenance: 'client',
  },
  { id: 'STORE_CH_ACCESSORY', npcs: ['NPC_CH_ACCESSORY'], tabs: [{ name: 'Goods', items: [RETURN_01.code, RETURN_03.code] }], provenance: 'client' },
  /** Every good above the cap: the NPC offers no shop at all. */
  { id: 'STORE_CH_CAPPED', npcs: ['NPC_CH_CAPPED'], tabs: [{ name: 'Armor', items: [CHEST_21.code] }], provenance: 'client' },
]

export const T0 = 1_000_000

export function npcHarness(opts: { validator?: MoveValidator; config?: Partial<ServerConfig>; npcs?: NpcDef[]; data?: GameData } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sro-npc-'))
  const logs: string[] = []
  const config: ServerConfig = { ...testConfig(root, logs), rng: seeded(7), ...opts.config }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, opts.validator ?? ((f, t) => nav.moveStraight(f, t)))
  const data = opts.data ?? new GameData({ mobs: [MANGNYANG], items: NPC_ITEMS, levels: LEVELS, drops: [], npcs: opts.npcs ?? NPC_DEFS, shops: SHOP_DEFS, towns: [] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(7) })
  let clock = T0
  gameplay.start(clock)
  let n = 0

  const npcByCode = (code: string) => {
    const found = [...world.npcs.values()].find((x) => x.code === code)
    if (!found) throw new Error(`no NPC ${code}`)
    return found
  }

  /** A fresh level-1 character at `pos`, in the world, with its view (known set) filled. */
  const enter = (pos: Vec3, gold = 0) => {
    const acc = store.createAccount(`npc${++n}`, 'x')!
    const row = store.createCharacter(acc, `Trader${n}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    gameplay.grantStarterKit(row.id, 'blade', row.model)
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(store.characterById(row.id)!), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos, yaw: 0, send: (m) => inbox.push(m) })
    world.snapshotFor(p, clock)
    if (gold) setGold(p, gold)
    return { p, inbox }
  }

  /** Runs an inventory edit directly on the database (test setup) and mirrors gold onto the player. */
  const edit = (p: Player, fn: (d: InvDraft) => void) => {
    const { draft } = store.inventoryTx(p.characterId, (d) => {
      fn(d)
      return { ok: true, value: undefined }
    })
    p.gold = draft.gold
  }
  const setGold = (p: Player, gold: number) => edit(p, (d) => d.setGold(gold))
  const give = (p: Player, code: string, count = 1, extra: Partial<InvItem> = {}) => {
    let slot = -1
    edit(p, (d) => {
      slot = d.firstFree()
      d.setBag(slot, { code, count, plus: 0, durability: null, ...extra })
    })
    return slot
  }
  const bag = (p: Player) => store.loadInventory(p.characterId).bag
  const countOf = (p: Player, code: string) => bag(p).reduce((s, i) => s + (i?.code === code ? i.count : 0), 0)

  /** Sends a request at the current clock and returns its actionResult. */
  const req = (p: Player, inbox: ServerMessage[], msg: GameplayMessage) => {
    const before = inbox.length
    gameplay.request(p, msg, clock)
    const r = inbox.slice(before).find((m): m is Msg<'actionResult'> => m.t === 'actionResult' && m.re === msg.t)
    if (!r) throw new Error(`no actionResult for ${msg.t}`)
    return r
  }
  const result = (inbox: ServerMessage[], re: GameplayRequest) => inbox.filter((m): m is Msg<'actionResult'> => m.t === 'actionResult' && m.re === re).at(-1)
  const of = <T extends ServerMessage['t']>(inbox: ServerMessage[], t: T) => inbox.filter((m): m is Msg<T> => m.t === t)

  /** Advances the clock by `ms` in world ticks (50 ms at 20 Hz). */
  const advance = (ms: number, step = 50) => {
    const end = clock + ms
    while (clock < end) {
      clock = Math.min(end, clock + step)
      world.tick(clock)
    }
  }

  const close = () => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }

  return { store, world, gameplay, data, config, logs, npcByCode, enter, edit, setGold, give, bag, countOf, req, result, of, advance, now: () => clock, close }
}

export type NpcHarness = ReturnType<typeof npcHarness>
