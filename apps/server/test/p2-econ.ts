/**
 * docs/SERVER_ARCHITECTURE.md phase P2: an economy harness shared by the equivalence test (p2-equivalence.test.ts) and
 * the crash-injection child (p2-crash-child.ts): a Gameplay over FlatNav with the fixtures, a storage keeper and a
 * merchant beside a town square, players who all see each other, and random economy steps — trades (items and gold),
 * stall purchases, storage deposits / withdrawals / gold, bag moves, shop buys and sales — driven through the real
 * request path (Gameplay.request: gates, services, the economy's transfers, commit-then-ack).
 */
import { mkdirSync } from 'node:fs'
import type { ClientMessage, GameplayRequest, ItemDef, NpcDef, ServerMessage, TownDef, Vec3 } from '@sro/shared'
import Database from 'better-sqlite3'
import type { WorldSetup } from '../src/content.ts'
import { openStore, type Store } from '../src/db.ts'
import type { DbWriterOptions } from '../src/db/mirror.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { addGold, addItem, type InvState } from '../src/inventory.ts'
import { FlatNav } from '../src/nav.ts'
import { World, type Player } from '../src/world.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, SHOPS, seeded } from './fixtures.ts'
import { testConfig } from './helpers.ts'

export const POTION = 'ITEM_ETC_HP_POTION_01'
export const BLADE = 'ITEM_CH_BLADE_02_A'
export const RING = 'ITEM_CH_RING_01_A'
const E_ITEMS: ItemDef[] = ITEMS.map((d) => (d.code.endsWith('_DEF') ? { ...d, canTrade: false } : d))
const def = (code: string) => E_ITEMS.find((d) => d.code === code)!
const TOWN: TownDef = { code: 'T', name: 'Town', world: 'jangan', spawn: { x: 0, y: 0, z: 0 }, safeArea: { x: 0, z: 0, halfX: 60, halfZ: 60 } }
const E_NPCS: NpcDef[] = [
  { code: 'NPC_CH_POTION', name: 'Potion Merchant', x: 0, z: 7, yaw: 0, world: 'jangan', shop: 'STORE_CH_POTION', model: null, provenance: 'client' },
  { code: 'NPC_CH_WAREHOUSE_W', name: 'Storage-keeper Sansan', x: 7, z: 0, yaw: 0, world: 'jangan', roles: ['storage'], model: null, provenance: 'client' },
]

export interface EconPlayer {
  p: Player
  inbox: ServerMessage[]
}

export interface EconOptions {
  root: string
  writer: boolean | DbWriterOptions
  svcBus: boolean
  seed?: number
  /** Each received message (the crash child prints the acknowledgements). */
  onMessage?: (who: EconPlayer, m: ServerMessage) => void
}

export type Econ = ReturnType<typeof econHarness>

export function econHarness(o: EconOptions) {
  const config = { ...testConfig(o.root), rng: seeded(o.seed ?? 3), storageFee: 0, spawnMobs: false, svcBus: o.svcBus }
  mkdirSync(config.dataDir, { recursive: true })
  const store = openStore(config.dataDir, { writer: o.writer })
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, (f, t) => nav.moveStraight(f, t))
  world.directory = o.svcBus
  const data = new GameData({ mobs: [MANGNYANG], items: E_ITEMS, levels: LEVELS, drops: DROPS, npcs: E_NPCS, shops: SHOPS, towns: [TOWN] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng: seeded(o.seed ?? 3) })
  gameplay.start()
  const npc = (code: string) => [...world.npcs.values()].find((n) => n.code === code)!.id
  const keeper = npc('NPC_CH_WAREHOUSE_W')
  const merchant = npc('NPC_CH_POTION')
  const players: EconPlayer[] = []

  /** Puts character `id` in the world at `pos` (every player sees every other). */
  const join = (id: number, pos: Vec3): EconPlayer => {
    const row = store.characterById(id)!
    const inbox: ServerMessage[] = []
    const x = {} as EconPlayer
    const p = world.add({ ...gameplay.playerInit(row), characterId: row.id, name: row.name, model: row.model, level: 1, weapon: row.weapon, pos, yaw: 0, send: (m) => { inbox.push(m); o.onMessage?.(x, m) } })
    x.p = p
    x.inbox = inbox
    for (const q of world.players.values()) {
      q.known.add(p.id)
      p.known.add(q.id)
    }
    players.push(x)
    return x
  }

  /** One request, as Connection.gameplay sends it. */
  const req = (x: EconPlayer, msg: ClientMessage, now: number) => gameplay.request(x.p, msg as Extract<ClientMessage, { t: GameplayRequest }>, now)

  return { store, world, gameplay, data, config, players, join, req, keeper, merchant }
}

/** Creates `n` characters with gold and a few items (one transaction each). Returns their ids. */
export function seedCharacters(store: Store, n: number, rng: () => number): number[] {
  const ids: number[] = []
  for (let i = 0; i < n; i++) {
    const acc = store.createAccount(`econ${i}`, 'x')!
    const row = store.createCharacter(acc, `Econ${i}`, 'CHAR_CH_MAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    ids.push(row.id)
    store.inventoryTx(row.id, (d) => {
      addGold(d, 5_000 + Math.floor(rng() * 5_000))
      const a = addItem(d, def(POTION), 10 + Math.floor(rng() * 40))
      if (!a.ok) return a
      const b = addItem(d, def(BLADE), 1 + Math.floor(rng() * 3))
      if (!b.ok) return b
      return addItem(d, def(RING), 1)
    })
  }
  return ids
}

/** Places every character of the store in the world around the square. */
export function joinAll(h: Econ): EconPlayer[] {
  const ids = (h.store.db.prepare('SELECT id FROM characters WHERE deleted_at IS NULL ORDER BY id').all() as { id: number }[]).map((r) => r.id)
  return ids.map((id, i) => h.join(id, [(i % 3) * 0.9, 0, Math.floor(i / 3) * 0.9]))
}

export type StepKind = 'trade' | 'tradeGold' | 'stall' | 'storage' | 'storageGold' | 'move' | 'shop'

/** A bag slot of `inv` holding a tradable item, or -1. */
function tradableSlot(inv: InvState, rng: () => number): number {
  const slots: number[] = []
  inv.bag.forEach((it, i) => {
    if (it && def(it.code)?.canTrade !== false) slots.push(i)
  })
  return slots.length ? slots[Math.floor(rng() * slots.length)]! : -1
}

/**
 * One random economy step at `now` between random players (`kinds` limits the choice). Returns its kind and the
 * transfer's key (social_log.at of a trade or stall purchase = `now`).
 */
export function step(h: Econ, rng: () => number, now: number, kinds: readonly StepKind[]): { kind: StepKind; at: number } {
  const ps = h.players
  const a = ps[Math.floor(rng() * ps.length)]!
  let b = ps[Math.floor(rng() * ps.length)]!
  if (b === a) b = ps[(ps.indexOf(a) + 1) % ps.length]!
  const kind = kinds[Math.floor(rng() * kinds.length)]!
  const inv = (x: EconPlayer) => h.store.loadInventory(x.p.characterId)
  switch (kind) {
    case 'trade':
    case 'tradeGold': {
      h.req(a, { t: 'tradeRequest', target: b.p.id }, now)
      h.req(b, { t: 'tradeRespond', from: a.p.id, accept: true }, now)
      if (kind === 'trade') {
        const slot = tradableSlot(inv(a), rng)
        if (slot >= 0) h.req(a, { t: 'tradeOffer', bag: slot }, now)
      }
      const gold = Math.floor(rng() * 300)
      if (gold) h.req(b, { t: 'tradeGold', amount: Math.min(gold, inv(b).gold) }, now)
      h.req(a, { t: 'tradeLock' }, now)
      h.req(b, { t: 'tradeLock' }, now)
      h.req(a, { t: 'tradeAccept' }, now)
      h.req(b, { t: 'tradeAccept' }, now)
      // a refused step leaves the window open: close it
      if (h.gameplay.trade.isTrading(a.p)) h.req(a, { t: 'tradeCancel' }, now)
      return { kind, at: now }
    }
    case 'stall': {
      const slot = tradableSlot(inv(a), rng)
      if (slot < 0) return { kind, at: now }
      const it = inv(a).bag[slot]!
      const price = 1 + Math.floor(rng() * 400)
      h.req(a, { t: 'stallCreate', title: 'Goods' }, now)
      h.req(a, { t: 'stallItem', slot: 0, bag: slot, count: it.count, price }, now)
      h.req(a, { t: 'stallOpen', open: true }, now)
      const msg: ClientMessage = { t: 'stallBuy', owner: a.p.id, slot: 0, code: it.code, count: it.count, price, ...(it.plus ? { plus: it.plus } : {}), ...(it.durability !== null ? { durability: it.durability } : {}) }
      h.req(b, msg, now)
      h.req(a, { t: 'stallClose' }, now)
      return { kind, at: now }
    }
    case 'storage': {
      const st = h.gameplay.storage.tables.load(h.store.characterById(a.p.characterId)!.account_id)
      const used = st.slots.flatMap((s, i) => (s ? [i] : []))
      if (used.length && rng() < 0.5) h.req(a, { t: 'storageWithdraw', npc: h.keeper, slot: used[Math.floor(rng() * used.length)]! }, now)
      else {
        const slot = tradableSlot(inv(a), rng)
        if (slot >= 0) h.req(a, { t: 'storageDeposit', npc: h.keeper, bag: slot }, now)
      }
      return { kind, at: now }
    }
    case 'storageGold': {
      const dir = rng() < 0.5 ? 'deposit' : 'withdraw'
      h.req(a, { t: 'storageGold', npc: h.keeper, dir, amount: 1 + Math.floor(rng() * 500) }, now)
      return { kind, at: now }
    }
    case 'move': {
      const n = inv(a).bagSize
      h.req(a, { t: 'itemMove', from: Math.floor(rng() * 8), to: Math.floor(rng() * n) }, now)
      return { kind, at: now }
    }
    case 'shop': {
      if (rng() < 0.5) h.req(a, { t: 'shopBuy', npc: h.merchant, item: POTION, count: 1 + Math.floor(rng() * 3) }, now)
      else {
        const slot = tradableSlot(inv(a), rng)
        if (slot >= 0) h.req(a, { t: 'shopSell', npc: h.merchant, bag: slot, count: 1 }, now)
      }
      return { kind, at: now }
    }
  }
}

/** The economy's ledger of a database file: gold (characters + storage) and every item code's count (bags, equipment, storage). */
export function ledger(file: string): { gold: number; items: Record<string, number>; characters: number } {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const g = db.prepare('SELECT (SELECT COALESCE(SUM(gold), 0) FROM characters) + (SELECT COALESCE(SUM(storage_gold), 0) FROM accounts) AS g').get() as { g: number }
    const items: Record<string, number> = {}
    for (const r of db.prepare('SELECT code, SUM(count) AS n FROM (SELECT code, count FROM items UNION ALL SELECT code, count FROM storage_items) GROUP BY code ORDER BY code').all() as { code: string; n: number }[]) items[r.code] = r.n
    const characters = (db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n
    return { gold: g.g, items, characters }
  } finally {
    db.close()
  }
}

/** Every row of every table of a database file, ordered (a whole-database comparison). */
export function dumpDb(file: string, omit: Record<string, readonly string[]> = {}): Record<string, unknown[]> {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const out: Record<string, unknown[]> = {}
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all() as string[]
    for (const t of tables) {
      const rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as Record<string, unknown>[]
      const drop = [...(omit[t] ?? []), ...(omit['*'] ?? [])]
      out[t] = drop.length ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k)))) : rows
    }
    return out
  } finally {
    db.close()
  }
}
