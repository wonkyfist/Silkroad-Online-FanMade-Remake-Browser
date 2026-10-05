import {
  CHARACTER_RULES,
  EQUIP_SLOTS,
  MAX_GOLD,
  MAX_ITEM_COUNT,
  type AdminCharacterDetail,
  type AdminCharacterRow,
  type AdminItemSlot,
  type AdminPage,
  type EquipSlot,
} from '@sro/shared'
import { knob } from '../config.ts'
import type { GameContext } from '../game.ts'
import { InvDraft, addItem, done, fail, takeFromBag, type Result } from '../inventory.ts'
import { setLevel as applySetLevel, type Progress } from '../progression.ts'
import { StorageDraft } from '../storage.ts'
import { itemSlot, storageOf, storageTables, toCharacterRow } from './accounts.ts'
import { onlineCharacter, type AdminCall } from './call.ts'
import { bad, body, conflict, int, notFound, paging, search, str, type Obj } from './http.ts'

/** Characters: list, view, progress, gold, send to town, bag / equipment / storage items (docs/ADMIN.md §1, §3). */

/** Highest SP the panel sets (far above anything earned at level 20). */
export const ADMIN_SP_MAX = 1_000_000_000
/** Highest + the panel gives (the alchemy ceiling of the data, ALCHEMY_MAX_PLUS at most 12). */
export const ADMIN_PLUS_MAX = 12

export function listCharacters(c: AdminCall): AdminPage<AdminCharacterRow> {
  const { page, size } = paging(c.query)
  const online = c.query.get('online') === '1'
  const ids = online ? [...c.ctx.sockets.values()].flatMap((s) => (s.player ? [s.player.characterId] : [])) : undefined
  const r = c.store.charactersPage({ q: search(c.query), ...(ids ? { ids } : {}) }, page, size)
  return { total: r.total, page, size, rows: r.rows.map((x) => toCharacterRow(c.ctx, x)) }
}

function row(c: AdminCall, id: number) {
  const r = c.ctx.store.characterById(id)
  if (!r || r.deleted_at !== null) throw notFound(`no character ${id}`)
  return r
}

export function characterDetail(c: AdminCall, id: number): AdminCharacterDetail {
  const { ctx } = c
  const r = row(c, id)
  const acc = ctx.store.accountById(r.account_id)!
  const live = onlineCharacter(ctx, id)
  const p = live?.player
  const progress: Progress = p
    ? { ...p.progress }
    : { level: r.level, exp: r.exp, sp: r.sp, spExp: r.sp_exp, str: r.strength, int: r.intellect, statPoints: r.stat_points }
  const inv = ctx.store.loadInventory(id)
  const bag: AdminItemSlot[] = []
  inv.bag.forEach((it, i) => {
    if (it) bag.push(itemSlot(ctx, i, it))
  })
  const equip: AdminItemSlot[] = []
  for (const slot of EQUIP_SLOTS) {
    const it = inv.equip[slot]
    if (it) equip.push(itemSlot(ctx, slot, it))
  }
  let position: AdminCharacterDetail['position'] = null
  if (p) {
    const at = ctx.world.livePoint(p, c.now)
    position = { x: at.x, y: at.y, z: at.z, zone: ctx.data.zoneName(at.x, at.z, ctx.setup.regionOrigin) }
  } else if (r.x !== null && r.z !== null && r.world === ctx.config.world) {
    position = { x: r.x, y: r.y ?? 0, z: r.z, zone: ctx.data.zoneName(r.x, r.z, ctx.setup.regionOrigin) }
  }
  return {
    id: r.id,
    name: r.name,
    accountId: r.account_id,
    account: acc.username,
    role: acc.role,
    level: progress.level,
    model: r.model,
    online: !!p,
    lastPlayed: r.last_played,
    progress: { ...progress, expToNext: ctx.data.expToNext(progress.level, ctx.config.levelCap) },
    gold: p ? p.gold : inv.gold,
    hp: p ? Math.round(p.hp) : r.hp,
    mp: p ? Math.round(p.mp) : r.mp,
    dead: p ? p.dead : r.dead === 1,
    position,
    bag: { size: inv.bagSize, items: bag },
    equip,
    storage: storageOf(ctx, r.account_id),
    masteries: c.store.masteries(id),
    skills: c.store.skills(id),
    levelCap: ctx.config.levelCap,
    maxPlus: Math.min(ADMIN_PLUS_MAX, knob(ctx.config, 'alchemyMaxPlus')),
  }
}

/** Runs an inventory change on a character (online: through the gameplay code, so the player sees it at once). */
function inventory(c: AdminCall, id: number, fn: (d: InvDraft) => Result<unknown>): void {
  const live = onlineCharacter(c.ctx, id)
  const { result, draft } = c.ctx.store.inventoryTx(id, fn)
  if (!result.ok) throw conflict(result.message ?? reasonText(result.reason))
  if (live) c.ctx.gameplay.afterInventory(live.player, draft)
}

function reasonText(reason: string): string {
  switch (reason) {
    case 'inventory_full':
      return 'The bag (or storage) is full.'
    case 'invalid_slot':
      return 'That slot is empty or does not exist.'
    case 'invalid_count':
      return 'That count is not possible here.'
    default:
      return `Refused: ${reason}.`
  }
}

export async function setProgress(c: AdminCall, id: number): Promise<AdminCharacterDetail> {
  const o = body(await c.body(), ['level', 'exp', 'sp', 'spExp'])
  const { ctx } = c
  const cap = ctx.config.levelCap
  const level = int(o, 'level', 1, cap, true)
  const exp = int(o, 'exp', 0, Number.MAX_SAFE_INTEGER, true)
  const sp = int(o, 'sp', 0, ADMIN_SP_MAX, true)
  const spExp = int(o, 'spExp', 0, CHARACTER_RULES.spExpPerSp - 1, true)
  if (level === undefined && exp === undefined && sp === undefined && spExp === undefined) throw bad('nothing to change')
  const r = row(c, id)
  const before = characterDetail(c, id).progress
  const live = onlineCharacter(ctx, id)
  const toNext = (l: number) => ctx.data.expToNext(l, cap)
  if (level !== undefined && level !== before.level) {
    if (live) ctx.gameplay.gmSetLevel(live.player, level)
    else {
      const prog: Progress = { level: r.level, exp: r.exp, sp: r.sp, spExp: r.sp_exp, str: r.strength, int: r.intellect, statPoints: r.stat_points }
      applySetLevel(prog, level, toNext)
      ctx.store.saveProgress(id, prog)
    }
  }
  if (exp !== undefined || sp !== undefined || spExp !== undefined) {
    const now = characterDetail(c, id).progress
    const need = toNext(now.level)
    if (exp !== undefined && exp > Math.max(0, need - 1)) throw bad(need > 0 ? `exp must be below ${need} at level ${now.level}` : `exp must be 0 at level ${now.level} (the cap)`)
    const next: Progress = { level: now.level, exp: exp ?? now.exp, sp: sp ?? now.sp, spExp: spExp ?? now.spExp, str: now.str, int: now.int, statPoints: now.statPoints }
    ctx.store.saveProgress(id, next)
    if (live) {
      live.player.progress = next
      live.player.send({ t: 'stats', stats: ctx.gameplay.stats(live.player) })
    }
  }
  const after = characterDetail(c, id)
  c.audit('character.progress', `character:${id}`, before, after.progress, true, r.name)
  return after
}

export async function setGold(c: AdminCall, id: number): Promise<AdminCharacterDetail> {
  const o = body(await c.body(), ['gold'])
  const gold = int(o, 'gold', 0, MAX_GOLD)
  const r = row(c, id)
  const before = characterDetail(c, id).gold
  inventory(c, id, (d) => {
    d.setGold(gold)
    return done(undefined)
  })
  c.audit('character.gold', `character:${id}`, { gold: before }, { gold }, true, r.name)
  return characterDetail(c, id)
}

export async function sendToTown(c: AdminCall, id: number): Promise<AdminCharacterDetail> {
  body((await c.body()) ?? {}, [])
  const r = row(c, id)
  const before = characterDetail(c, id).position
  const live = onlineCharacter(c.ctx, id)
  if (live) {
    c.ctx.gameplay.toTown(live.player)
    live.player.send({ t: 'chat', channel: 'system', text: 'An administrator sent you to town.' })
    c.ctx.persist([live.player])
  } else c.store.clearPosition(id)
  c.audit('character.town', `character:${id}`, before, live ? 'town' : 'town (on next login)', true, r.name)
  return characterDetail(c, id)
}

function itemArgs(c: AdminCall, o: Obj): { def: NonNullable<ReturnType<GameContext['data']['item']>>; count: number; plus: number } {
  const code = str(o, 'code', 128).trim().toUpperCase()
  const def = c.ctx.data.item(code)
  if (!def) throw bad(`no item ${code}`)
  const count = int(o, 'count', 1, MAX_ITEM_COUNT)
  const plus = int(o, 'plus', 0, ADMIN_PLUS_MAX, true) ?? 0
  if (plus > 0 && def.slot === undefined) throw bad('only equipment takes a + level')
  return { def, count, plus }
}

export async function giveItem(c: AdminCall, id: number): Promise<AdminCharacterDetail> {
  const o = body(await c.body(), ['code', 'count', 'plus'])
  const { def, count, plus } = itemArgs(c, o)
  const r = row(c, id)
  inventory(c, id, (d) => addItem(d, def, count, plus))
  c.audit('character.item.give', `character:${id}`, null, { code: def.code, count, plus }, true, r.name)
  return characterDetail(c, id)
}

export async function removeItem(c: AdminCall, id: number): Promise<AdminCharacterDetail> {
  const o = body(await c.body(), ['where', 'slot', 'count'])
  const r = row(c, id)
  let taken: unknown = null
  if (o.where === 'bag') {
    const slot = int(o, 'slot', 0, 1000)
    const count = int(o, 'count', 1, MAX_ITEM_COUNT, true)
    inventory(c, id, (d) => {
      const t = takeFromBag(d, slot, count)
      if (t.ok) taken = { slot, ...t.value }
      return t
    })
  } else if (o.where === 'equip') {
    if (o.count !== undefined) throw bad('equipment is removed whole (no count)')
    const slot = o.slot as EquipSlot
    if (typeof slot !== 'string' || !EQUIP_SLOTS.includes(slot)) throw bad(`slot must be one of ${EQUIP_SLOTS.join(', ')}`)
    inventory(c, id, (d) => {
      const it = d.equip[slot]
      if (!it) return fail('invalid_slot', `Nothing is worn in ${slot}.`)
      taken = { slot, ...it }
      d.setEquip(slot, null)
      return done(undefined)
    })
  } else throw bad("where must be 'bag' or 'equip'")
  c.audit('character.item.remove', `character:${id}`, taken, null, true, r.name)
  return characterDetail(c, id)
}

// ---- account storage ------------------------------------------------------------------------------------------

/** Runs a change on an account's storage in one transaction; tells its player (if in the world) with storageUpdate. */
function storage(c: AdminCall, accountId: number, fn: (st: StorageDraft) => Result<unknown>): void {
  const tables = storageTables(c.ctx)
  let result: Result<unknown> = done(undefined)
  let draft: StorageDraft | null = null
  c.ctx.store.db.transaction(() => {
    const st = new StorageDraft(tables.load(accountId))
    result = fn(st)
    if (result.ok && st.changed) {
      tables.write(accountId, st)
      draft = st
    }
  })()
  if (!result.ok) throw conflict(result.message ?? reasonText(result.reason))
  const p = c.ctx.sockets.get(accountId)?.player
  const d = draft as StorageDraft | null
  if (p && d) p.send({ t: 'storageUpdate', ...d.updates() })
}

function account(c: AdminCall, accountId: number): string {
  const a = c.ctx.store.accountById(accountId)
  if (!a) throw notFound(`no account ${accountId}`)
  return a.username
}

export async function giveStorageItem(c: AdminCall, accountId: number): Promise<ReturnType<typeof storageOf>> {
  const o = body(await c.body(), ['code', 'count', 'plus'])
  const { def, count, plus } = itemArgs(c, o)
  const name = account(c, accountId)
  storage(c, accountId, (st) => {
    // The bag's stacking rule over the storage slots (top up stacks, then empty slots; all or nothing).
    const d = new InvDraft({ bagSize: st.size, bag: st.slots, equip: {}, gold: 0 })
    const r = addItem(d, def, count, plus)
    if (r.ok) for (const i of d.touchedBag) st.setSlot(i, d.bag[i])
    return r
  })
  c.audit('storage.item.give', `account:${accountId}`, null, { code: def.code, count, plus }, true, name)
  return storageOf(c.ctx, accountId)
}

export async function removeStorageItem(c: AdminCall, accountId: number): Promise<ReturnType<typeof storageOf>> {
  const o = body(await c.body(), ['where', 'slot', 'count'])
  if (o.where !== undefined && o.where !== 'storage') throw bad("where must be 'storage'")
  const slot = int(o, 'slot', 0, 1000)
  const count = int(o, 'count', 1, MAX_ITEM_COUNT, true)
  const name = account(c, accountId)
  let taken: unknown = null
  storage(c, accountId, (st) => {
    const it = st.inStorage(slot) ? st.slots[slot] : null
    if (!it) return fail('invalid_slot')
    const n = count ?? it.count
    if (n > it.count) return fail('invalid_count')
    taken = { slot, ...it, count: n }
    st.setSlot(slot, n === it.count ? null : { ...it, count: it.count - n })
    return done(undefined)
  })
  c.audit('storage.item.remove', `account:${accountId}`, taken, null, true, name)
  return storageOf(c.ctx, accountId)
}

export async function setStorageGold(c: AdminCall, accountId: number): Promise<ReturnType<typeof storageOf>> {
  const o = body(await c.body(), ['gold'])
  const gold = int(o, 'gold', 0, MAX_GOLD)
  const name = account(c, accountId)
  const before = storageOf(c.ctx, accountId).gold
  storage(c, accountId, (st) => {
    st.setGold(gold)
    return done(undefined)
  })
  c.audit('storage.gold', `account:${accountId}`, { gold: before }, { gold }, true, name)
  return storageOf(c.ctx, accountId)
}
