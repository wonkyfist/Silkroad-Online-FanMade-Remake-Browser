import {
  ACCOUNT_NAME,
  ADMIN_BAN_REASON_MAX,
  ADMIN_KICK_REASON_MAX,
  CLOSE_CODE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  ROLES,
  codePointLength,
  type AdminAccountDetail,
  type AdminAccountRow,
  type AdminCharacterRow,
  type AdminItemSlot,
  type AdminPage,
  type AdminStorage,
  type Role,
} from '@sro/shared'
import { hashPassword } from '../auth.ts'
import { cleanChat } from '../connection.ts'
import type { GameContext } from '../game.ts'
import type { InvItem } from '../inventory.ts'
import { openStorageStore, type StorageStore } from '../storage-db.ts'
import type { AdminCall } from './call.ts'
import { itemIcon } from './icons.ts'
import { AdminError, bad, body, conflict, notFound, paging, search, str, type Obj } from './http.ts'
import type { AccountListRow, CharacterListRow } from './store.ts'

/**
 * Accounts: list, create, reset password, ban / unban, kick (docs/ADMIN.md §1, §3). Roles are shown but never changed
 * here: the owner-only role policy (test/role-policy.test.ts) keeps every role change in the server-side CLI.
 */

const STORAGE = new WeakMap<GameContext, StorageStore>()

export function storageTables(ctx: GameContext): StorageStore {
  let t = STORAGE.get(ctx)
  if (!t) STORAGE.set(ctx, (t = openStorageStore(ctx.store)))
  return t
}

export function itemSlot(ctx: GameContext, slot: AdminItemSlot['slot'], it: InvItem): AdminItemSlot {
  const def = ctx.data.item(it.code)
  return { slot, code: it.code, name: def?.name ?? null, count: it.count, plus: it.plus, durability: it.durability, icon: itemIcon(ctx, it.code, def) }
}

export function storageOf(ctx: GameContext, accountId: number): AdminStorage {
  const st = storageTables(ctx).load(accountId)
  const items: AdminItemSlot[] = []
  st.slots.forEach((it, i) => {
    if (it) items.push(itemSlot(ctx, i, it))
  })
  return { size: st.size, gold: st.gold, items }
}

export function toAccountRow(ctx: GameContext, r: AccountListRow): AdminAccountRow {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    createdAt: r.created_at,
    lastLogin: r.last_login,
    online: ctx.sockets.has(r.id),
    banned: r.banned_at !== null ? { reason: r.reason ?? '', at: r.banned_at, by: r.banned_by ?? '' } : null,
    characters: r.chars,
  }
}

export function toCharacterRow(ctx: GameContext, r: CharacterListRow): AdminCharacterRow {
  const conn = ctx.sockets.get(r.account_id)
  return { id: r.id, name: r.name, accountId: r.account_id, account: r.username, level: r.level, model: r.model, online: conn?.player?.characterId === r.id, lastPlayed: r.last_played }
}

export function listAccounts(c: AdminCall): AdminPage<AdminAccountRow> {
  const { page, size } = paging(c.query)
  const role = c.query.get('role') ?? ''
  if (role && !ROLES.includes(role as Role)) throw bad('role must be player, gm or admin')
  const bannedQ = c.query.get('banned') ?? ''
  if (bannedQ && bannedQ !== '1' && bannedQ !== '0') throw bad('banned must be 1 or 0')
  const r = c.store.accountsPage({ q: search(c.query), ...(role ? { role: role as Role } : {}), ...(bannedQ ? { banned: bannedQ === '1' } : {}) }, page, size)
  return { total: r.total, page, size, rows: r.rows.map((x) => toAccountRow(c.ctx, x)) }
}

function account(c: AdminCall, id: number): AccountListRow {
  const r = c.store.accountRow(id)
  if (!r) throw notFound(`no account ${id}`)
  return r
}

export function accountDetail(c: AdminCall, id: number): AdminAccountDetail {
  const r = account(c, id)
  const chars = c.ctx.store.characters(id)
  const characterList: AdminCharacterRow[] = chars.map((ch) => toCharacterRow(c.ctx, { id: ch.id, name: ch.name, account_id: id, username: r.username, level: ch.level, model: ch.model, last_played: ch.last_played }))
  return { ...toAccountRow(c.ctx, r), characterList, storage: storageOf(c.ctx, id) }
}

function passwordOf(o: Obj): string {
  const p = o.password
  if (typeof p !== 'string') throw bad('password must be a string')
  const n = codePointLength(p)
  if (n < PASSWORD_MIN_LENGTH || n > PASSWORD_MAX_LENGTH) throw bad(`password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`)
  return p
}

/** Closes the account's live socket (lobby or world) after a system line; true when there was one. */
export function kickAccount(ctx: GameContext, accountId: number, line: string, reason: string): boolean {
  const conn = ctx.sockets.get(accountId)
  if (!conn) return false
  conn.send({ t: 'chat', channel: 'system', text: line })
  conn.close(CLOSE_CODE.kicked, Buffer.from(reason).subarray(0, 120).toString('utf8').replace(/�+$/, ''))
  return true
}

export async function createAccount(c: AdminCall): Promise<AdminAccountDetail> {
  // No role field: roles change only through the owner's CLI (pnpm gm grant; test/role-policy.test.ts). New accounts are players.
  const o = body(await c.body(), ['username', 'password'])
  const username = str(o, 'username', 16)
  if (!ACCOUNT_NAME.test(username)) throw bad('username must be 3-16 letters, digits or _')
  const password = passwordOf(o)
  if (c.ctx.store.accountByName(username)) {
    c.audit('account.create', `account:${username}`, undefined, { username }, false, 'name taken')
    throw new AdminError(409, 'name_taken', 'username is taken')
  }
  const id = c.ctx.store.createAccount(username, await hashPassword(password))
  if (id === null) throw new AdminError(409, 'name_taken', 'username is taken')
  c.audit('account.create', `account:${id}`, null, { username })
  c.ctx.config.log(`admin ${c.admin.username}: created account ${username}`)
  return accountDetail(c, id)
}

export async function resetPassword(c: AdminCall, id: number): Promise<AdminAccountDetail> {
  const o = body(await c.body(), ['password'])
  const password = passwordOf(o)
  const r = account(c, id)
  const hash = await hashPassword(password)
  c.store.setPassword(id, hash)
  const sessions = c.store.deleteGameSessionsOf(id)
  // Other admin sessions of that account end too (the caller's own one stays when it resets its own password).
  kickAccount(c.ctx, id, 'Your password was changed by an administrator. Log in again.', 'password changed')
  if (id !== c.admin.id) c.store.deleteSessionsOf(id)
  c.audit('account.password', `account:${id}`, null, { username: r.username, sessionsRevoked: sessions })
  return accountDetail(c, id)
}

export async function ban(c: AdminCall, id: number): Promise<AdminAccountDetail> {
  const o = body(await c.body(), ['reason'])
  const reason = cleanChat(str(o, 'reason', ADMIN_BAN_REASON_MAX)).replace(/\s+/g, ' ')
  if (!reason) throw bad('a ban needs a reason')
  const r = account(c, id)
  if (id === c.admin.id) throw conflict('You cannot ban yourself.')
  const before = c.store.banOf(id)
  c.store.ban(id, reason, c.admin.username, c.now)
  const sessions = c.store.deleteGameSessionsOf(id)
  c.store.deleteSessionsOf(id)
  const kicked = kickAccount(c.ctx, id, `Your account was banned: ${reason}`, `banned: ${reason}`)
  c.audit('account.ban', `account:${id}`, before, { reason, username: r.username, sessionsRevoked: sessions, kicked })
  c.ctx.config.log(`admin ${c.admin.username}: banned ${r.username} (${reason})`)
  return accountDetail(c, id)
}

export async function unban(c: AdminCall, id: number): Promise<AdminAccountDetail> {
  body((await c.body()) ?? {}, [])
  const r = account(c, id)
  const before = c.store.banOf(id)
  if (!before) return accountDetail(c, id)
  c.store.unban(id)
  c.audit('account.unban', `account:${id}`, before, null, true, r.username)
  c.ctx.config.log(`admin ${c.admin.username}: unbanned ${r.username}`)
  return accountDetail(c, id)
}

export async function kick(c: AdminCall, id: number): Promise<{ kicked: boolean }> {
  const o = body((await c.body()) ?? {}, ['reason'])
  const reason = cleanChat(str(o, 'reason', ADMIN_KICK_REASON_MAX, true) ?? '')
  const r = account(c, id)
  if (id === c.admin.id) throw conflict('You cannot kick yourself.')
  const kicked = kickAccount(c.ctx, id, `You were disconnected by an administrator${reason ? `: ${reason}` : '.'}`, `kicked${reason ? `: ${reason}` : ''}`)
  if (!kicked) throw conflict(`${r.username} is not online.`)
  c.audit('account.kick', `account:${id}`, undefined, { reason }, true, r.username)
  return { kicked }
}
