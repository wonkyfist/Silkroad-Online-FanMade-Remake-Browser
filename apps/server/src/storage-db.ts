import { NPC_INTERACT_RANGE, STORAGE_SIZE_DEFAULT, type GameplayRequest } from '@sro/shared'
import type { Store } from './db.ts'
import type { Gameplay } from './gameplay.ts'
import { InvDraft, fail, type Defs, type InvItem, type Result } from './inventory.ts'
import type { Answer, GameplayMessage, GameplayModule } from './modules.ts'
import { StorageDraft, deposit, goldIn, goldOut, moveStored, toAccountStorage, withdraw, type StorageState } from './storage.ts'
import type { Npc, Player } from './world.ts'

/**
 * Account storage, database side and requests (docs/SHOPS.md §5, docs/WAVE_PLAN.md §4.7; lane ST-S), on the v6
 * tables (`storage_items`, `accounts.storage_gold`, `accounts.storage_size`).
 *
 * The chest belongs to the account: every character of it sees the same items and gold, and deleting a character
 * keeps them. An account has at most one connection and a connection at most one player, and every request runs
 * in one SQLite transaction that re-reads the bag and the chest, so nothing can be duplicated or lost.
 *
 * Every request carries the storage keeper's entity id, which must be a live NPC with the `storage` role
 * (else `not_found`) within NPC_INTERACT_RANGE (else `too_far`). No open dialog is required (SHOPS §3.1 step 6).
 */

interface StorageRow {
  slot: number
  code: string
  count: number
  plus: number
  durability: number | null
}

export type StorageStore = ReturnType<typeof openStorageStore>

/** Storage statements on the game database (call inside or outside a transaction; `storageTx` makes one). */
export function openStorageStore(store: Store) {
  const db = store.db
  const q = {
    items: db.prepare<[number], StorageRow>('SELECT slot, code, count, plus, durability FROM storage_items WHERE account_id = ? ORDER BY slot'),
    account: db.prepare<[number], { storage_gold: number; storage_size: number }>('SELECT storage_gold, storage_size FROM accounts WHERE id = ?'),
    deleteSlot: db.prepare<[number, number]>('DELETE FROM storage_items WHERE account_id = ? AND slot = ?'),
    insert: db.prepare<[number, number, string, number, number, number | null]>(
      'INSERT INTO storage_items (account_id, slot, code, count, plus, durability) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    setGold: db.prepare<[number, number]>('UPDATE accounts SET storage_gold = ? WHERE id = ?'),
  }

  function load(accountId: number): StorageState {
    const acc = q.account.get(accountId)
    if (!acc) throw new Error(`no account ${accountId}`)
    const size = acc.storage_size ?? STORAGE_SIZE_DEFAULT
    const slots: (InvItem | null)[] = Array.from({ length: size }, () => null)
    for (const r of q.items.all(accountId)) {
      if (r.slot < size) slots[r.slot] = { code: r.code, count: r.count, plus: r.plus, durability: r.durability }
    }
    return { size, slots, gold: acc.storage_gold }
  }

  function write(accountId: number, st: StorageDraft): void {
    for (const slot of st.touched) {
      q.deleteSlot.run(accountId, slot)
      const it = st.slots[slot]
      if (it) q.insert.run(accountId, slot, it.code, it.count, it.plus, it.durability)
    }
    if (st.goldChanged) q.setGold.run(st.gold, accountId)
  }

  /**
   * Runs one storage operation atomically: loads the character's inventory and the account's chest, lets `fn`
   * change both drafts, and writes back the touched slots and gold only when `fn` succeeded (one SQLite
   * transaction; a throw rolls both tables back).
   */
  function storageTx<T>(characterId: number, accountId: number, fn: (inv: InvDraft, st: StorageDraft) => Result<T>): { result: Result<T>; inv: InvDraft; st: StorageDraft } {
    const out = {} as { result: Result<T>; inv: InvDraft; st: StorageDraft }
    db.transaction(() => {
      out.inv = new InvDraft(store.loadInventory(characterId))
      out.st = new StorageDraft(load(accountId))
      out.result = fn(out.inv, out.st)
      if (out.result.ok) {
        if (out.inv.changed) store.writeDraft(characterId, out.inv)
        if (out.st.changed) write(accountId, out.st)
      }
    })()
    return out
  }

  return { load, write, storageTx }
}

export class StorageService implements GameplayModule {
  readonly name = 'storage'
  readonly handles: readonly GameplayRequest[] = ['storageOpen', 'storageDeposit', 'storageWithdraw', 'storageMove', 'storageGold']
  /** Whether the storage service exists (NpcDialogs.servicesOf offers 'storage' only when true). */
  readonly enabled: boolean = true
  /** characterId -> accountId (looked up once per stay in the world). */
  private readonly accounts = new Map<number, number>()
  private db: StorageStore | null = null

  constructor(readonly g: Gameplay) {}

  /** The statements, prepared on first use. */
  get tables(): StorageStore {
    return (this.db ??= openStorageStore(this.g.store))
  }

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    switch (msg.t) {
      case 'storageOpen':
        return this.open(p, msg.npc, answer, now)
      case 'storageDeposit':
        return this.run(p, msg.npc, answer, now, (inv, st) => deposit(inv, st, msg.bag, msg.count, msg.to, this.defs, this.g.config.storageFee ?? 1))
      case 'storageWithdraw':
        return this.run(p, msg.npc, answer, now, (inv, st) => withdraw(inv, st, msg.slot, msg.count, msg.bag, this.defs))
      case 'storageMove':
        return this.run(p, msg.npc, answer, now, (_inv, st) => moveStored(st, msg.from, msg.to, this.defs))
      case 'storageGold':
        return this.run(p, msg.npc, answer, now, (inv, st) => (msg.dir === 'deposit' ? goldIn(inv, st, msg.amount) : goldOut(inv, st, msg.amount)))
      default:
        return answer(fail('not_found'))
    }
  }

  forget(p: Player): void {
    this.accounts.delete(p.characterId)
  }

  private readonly defs: Defs = (code) => this.g.data.item(code)

  /** The storage keeper `npcId`, if it is one and `p` stands within NPC_INTERACT_RANGE of it. */
  keeper(p: Player, npcId: number, now: number): Result<Npc> {
    const npc = this.g.world.npcs.get(npcId)
    if (!npc) return fail('not_found')
    const def = this.g.data.npcs.find((n) => n.code === npc.code)
    if (!def?.roles?.includes('storage')) return fail('not_found', 'this NPC does not keep storage')
    if (this.g.world.distance(p, npc, now) > NPC_INTERACT_RANGE) return fail('too_far')
    return { ok: true, value: npc }
  }

  private accountOf(p: Player): number | null {
    let id = this.accounts.get(p.characterId)
    if (id === undefined) {
      id = this.g.store.characterById(p.characterId)?.account_id
      if (id === undefined) return null
      this.accounts.set(p.characterId, id)
    }
    return id
  }

  private open(p: Player, npcId: number, answer: Answer, now: number): void {
    const k = this.keeper(p, npcId, now)
    if (!k.ok) return answer(k)
    const account = this.accountOf(p)
    if (account === null) return answer(fail('not_found'))
    const storage = toAccountStorage(this.tables.load(account))
    answer(true)
    p.send({ t: 'storage', storage })
  }

  /** One storage transaction, then: actionResult -> inventoryUpdate (+ statsDelta gold) -> storageUpdate (SHOPS §7.3). */
  private run(p: Player, npcId: number, answer: Answer, now: number, fn: (inv: InvDraft, st: StorageDraft) => Result<unknown>): void {
    const k = this.keeper(p, npcId, now)
    if (!k.ok) return answer(k)
    const account = this.accountOf(p)
    if (account === null) return answer(fail('not_found'))
    const { result, inv, st } = this.tables.storageTx(p.characterId, account, fn)
    if (!result.ok) return answer(result)
    answer(true)
    if (inv.changed) this.g.afterInventory(p, inv)
    const up = st.updates()
    if (up.slots || up.gold !== undefined) p.send({ t: 'storageUpdate', ...up })
  }
}
