import {
  AUTHORED_NPC_CODE,
  CODE_NAME,
  GM_API_MAX_BODY_BYTES,
  QUEST_ID,
  type AdminNestRow,
  type AdminNpcRow,
  type AdminPage,
  type AdminQuestDetail,
  type AdminQuestRow,
  type AdminUniquesView,
} from '@sro/shared'
import type { GameContext } from '../game.ts'
import type { GmResult } from '../gm.ts'
import { editorState } from '../editors/live.ts'
import { addNestAt, moveNestTo, nestEdits, nestInfo } from '../editors/nest-edit.ts'
import { addNpcAt, allNpcs, npcEdits, npcInfo, placeNpcAt } from '../editors/npc-edit.ts'
import { NEST_COUNT_MAX, NEST_RADIUS_MAX, NEST_RADIUS_MIN, NEST_RESPAWN_MAX_SEC } from '../editors/overrides.ts'
import { questEntries, questRoute, runQuestEditor } from '../editors/quest-api.ts'
import type { AdminCall } from './call.ts'
import { mobIcon } from './icons.ts'
import { AdminError, bad, body, conflict, flag, int, notFound, num, pageOf, paging, search, str, type Obj } from './http.ts'

/**
 * The world content pages (docs/ADMIN.md §1): nests, NPCs and quests through the GM editors' own functions (the same
 * checks, override files, history, live application and `contentChanged`), and the unique bosses through the uniques
 * module's GM entry. Coordinates are world metres (glTF x/z, as the GM `where` shows them).
 */

const COORD_MAX = 1e6

/** A GmResult as an answer: ok -> its data and message; refused -> 409 with the editor's own message. */
function result(r: GmResult): { message: string; data: unknown } {
  if (!r.ok) throw conflict(r.message)
  return { message: r.message, data: r.data ?? null }
}

/** The ground at x/z (the navmesh surface nearest the top; flat worlds: the spawn height). */
function groundAt(ctx: GameContext, x: number, z: number): { x: number; y: number; z: number } {
  const [cx, cz] = ctx.world.clamp(x, z)
  const at = ctx.world.placeFor(cx, cz, Infinity)
  if (at) return at
  if (ctx.world.nav.kind === 'mesh') throw conflict(`No walkable ground near ${x.toFixed(1)}, ${z.toFixed(1)}.`)
  return { x: cx, y: ctx.setup.spawn.y, z: cz }
}

function point(o: Obj): { x: number; z: number } {
  return { x: num(o, 'x', -COORD_MAX, COORD_MAX), z: num(o, 'z', -COORD_MAX, COORD_MAX) }
}

function code(raw: string, what: string): string {
  const c = raw.trim().toUpperCase()
  if (!CODE_NAME.test(c)) throw bad(`${what} must be a code like MOB_CH_TIGER`)
  return c
}

// ---- nests --------------------------------------------------------------------------------------------------

export function listNests(c: AdminCall): AdminPage<AdminNestRow> {
  const { ctx } = c
  const { page, size } = paging(c.query)
  const q = search(c.query).toLowerCase()
  const source = c.query.get('source') ?? ''
  const st = editorState(ctx)
  const rows: AdminNestRow[] = ctx.data.nests.filter((n) => n.world === ctx.config.world).map((n) => nestInfo(ctx, n, st.nests))
  for (const id of st.nests.remove) {
    const def = st.base.nests.find((n) => n.id === id && n.world === ctx.config.world)
    if (def) rows.push({ ...nestInfo(ctx, def, st.nests), alive: 0, removed: true })
  }
  const hits = rows
    .filter((r) => !q || String(r.id) === q || r.mob.toLowerCase().includes(q) || r.mobName.toLowerCase().includes(q))
    .filter((r) => !source || (source === 'removed' ? r.removed === true : r.source === source && !r.removed))
    .sort((a, b) => a.mobName.localeCompare(b.mobName) || a.id - b.id)
  const out = pageOf(hits, page, size)
  for (const r of out.rows) r.icon = mobIcon(ctx, r.mob)
  return out
}

export async function addNest(c: AdminCall): Promise<{ message: string; data: unknown }> {
  const o = body(await c.body(), ['mob', 'x', 'z', 'count', 'radius', 'respawnSec'])
  const mob = code(str(o, 'mob', 128), 'mob')
  const p = point(o)
  const count = int(o, 'count', 1, NEST_COUNT_MAX, true) ?? 5
  const radius = num(o, 'radius', NEST_RADIUS_MIN, NEST_RADIUS_MAX, true) ?? 30
  const respawn = respawnOf(o) ?? [30, 30]
  const r = result(addNestAt(c.ctx, c.admin.username, groundAt(c.ctx, p.x, p.z), mob, count, radius, respawn))
  c.audit('nest.add', 'nests', null, { mob, ...p, count, radius, respawnSec: respawn }, true, r.message.split('\n')[0])
  return r
}

function respawnOf(o: Obj): [number, number] | undefined {
  const v = o.respawnSec
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => Number.isInteger(x) && x >= 1 && x <= NEST_RESPAWN_MAX_SEC) || v[0] > v[1]) {
    throw bad(`respawnSec must be [min, max] seconds, 1-${NEST_RESPAWN_MAX_SEC}`)
  }
  return [v[0], v[1]]
}

/** POST nests/:id: each field becomes one `nest set` of the GM editor (stopping at the first refusal). */
export async function setNest(c: AdminCall, id: number): Promise<{ message: string; data: unknown }> {
  const o = body(await c.body(), ['mob', 'count', 'radius', 'spawnRadius', 'respawnSec', 'aggressive', 'championPct', 'enabled'])
  const sets: [string, string][] = []
  if (o.mob !== undefined) sets.push(['mob', code(str(o, 'mob', 128), 'mob')])
  if (o.count !== undefined) sets.push(['count', String(int(o, 'count', 1, NEST_COUNT_MAX))])
  if (o.radius !== undefined) sets.push(['radius', String(num(o, 'radius', NEST_RADIUS_MIN, NEST_RADIUS_MAX))])
  if (o.spawnRadius !== undefined) sets.push(['spawnradius', String(num(o, 'spawnRadius', 0, NEST_RADIUS_MAX))])
  const respawn = respawnOf(o)
  if (respawn) sets.push(['respawn', `${respawn[0]}-${respawn[1]}`])
  const aggressive = flag(o, 'aggressive')
  if (aggressive !== undefined) sets.push(['aggressive', aggressive ? 'on' : 'off'])
  if (o.championPct !== undefined) sets.push(['champion', String(num(o, 'championPct', 0, 100))])
  const enabled = flag(o, 'enabled')
  if (enabled !== undefined) sets.push(['enabled', enabled ? 'on' : 'off'])
  if (sets.length === 0) throw bad('nothing to change')
  const before = listNestById(c, id)
  let last: { message: string; data: unknown } = { message: '', data: null }
  for (const [field, value] of sets) {
    const r = nestEdits.set({ ctx: c.ctx, args: ['set', String(id), field, value] })
    if (!r.ok) {
      c.audit('nest.set', `nest:${id}`, before, o, false, r.message)
      throw conflict(r.message)
    }
    last = { message: r.message, data: r.data ?? null }
  }
  c.audit('nest.set', `nest:${id}`, before, listNestById(c, id))
  return last
}

function listNestById(c: AdminCall, id: number): AdminNestRow | null {
  const def = c.ctx.data.nests.find((n) => n.id === id && n.world === c.ctx.config.world)
  return def ? nestInfo(c.ctx, def) : null
}

export async function moveNest(c: AdminCall, id: number): Promise<{ message: string; data: unknown }> {
  const o = body(await c.body(), ['x', 'z'])
  const p = point(o)
  const before = listNestById(c, id)
  const r = result(moveNestTo(c.ctx, id, groundAt(c.ctx, p.x, p.z)))
  c.audit('nest.move', `nest:${id}`, before && { x: before.x, z: before.z }, p)
  return r
}

async function nestSimple(c: AdminCall, id: number | null, what: 'remove' | 'restore' | 'undo'): Promise<{ message: string; data: unknown }> {
  body((await c.body()) ?? {}, [])
  const before = id === null ? null : listNestById(c, id)
  const r = nestEdits[what]({ ctx: c.ctx, args: id === null ? [what] : [what, String(id)] })
  c.audit(`nest.${what}`, id === null ? 'nests' : `nest:${id}`, before, null, r.ok, r.message.split('\n')[0])
  return result(r)
}

export const removeNest = (c: AdminCall, id: number) => nestSimple(c, id, 'remove')
export const restoreNest = (c: AdminCall, id: number) => nestSimple(c, id, 'restore')
export const undoNests = (c: AdminCall) => nestSimple(c, null, 'undo')

// ---- NPCs ---------------------------------------------------------------------------------------------------

export function listNpcs(c: AdminCall): AdminPage<AdminNpcRow> {
  const { ctx } = c
  const { page, size } = paging(c.query)
  const q = search(c.query).toLowerCase()
  const st = editorState(ctx)
  const rows = allNpcs(ctx)
    .map((n) => npcInfo(ctx, n.def, n.base, n.hidden, st.npcs))
    .filter((r) => !q || r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || (r.shop ?? '').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code))
  return pageOf(rows, page, size)
}

function npcByCode(c: AdminCall, npc: string): AdminNpcRow | null {
  const n = allNpcs(c.ctx).find((x) => x.def.code === npc)
  return n ? npcInfo(c.ctx, n.def, n.base, n.hidden) : null
}

export async function addNpc(c: AdminCall): Promise<{ message: string; data: unknown }> {
  const o = body(await c.body(), ['base', 'name', 'x', 'z', 'yaw'])
  const base = code(str(o, 'base', 128), 'base')
  const name = str(o, 'name', 64)
  const p = point(o)
  const yaw = num(o, 'yaw', -Math.PI * 4, Math.PI * 4, true) ?? 0
  const r = result(addNpcAt(c.ctx, base, name, groundAt(c.ctx, p.x, p.z), yaw))
  c.audit('npc.add', 'npcs', null, { base, name, ...p, yaw }, true, r.message.split('\n')[0])
  return r
}

export async function setNpc(c: AdminCall, raw: string): Promise<{ message: string; data: unknown }> {
  const npc = code(raw, 'the NPC code')
  const o = body(await c.body(), ['name', 'shop'])
  const before = npcByCode(c, npc)
  const steps: string[][] = []
  if (o.name !== undefined) steps.push(['rename', npc, ...str(o, 'name', 64).split(/\s+/).filter(Boolean)])
  if (o.shop !== undefined) {
    if (o.shop !== null && typeof o.shop !== 'string') throw bad('shop must be a shop id or null')
    steps.push(['shop', npc, o.shop === null ? 'none' : (o.shop as string).trim() || 'none'])
  }
  if (steps.length === 0) throw bad('nothing to change')
  let last: { message: string; data: unknown } = { message: '', data: null }
  for (const args of steps) {
    const r = (args[0] === 'rename' ? npcEdits.rename : npcEdits.shop)({ ctx: c.ctx, args })
    if (!r.ok) {
      c.audit('npc.set', `npc:${npc}`, before, o, false, r.message)
      throw conflict(r.message)
    }
    last = { message: r.message, data: r.data ?? null }
  }
  c.audit('npc.set', `npc:${npc}`, before, npcByCode(c, npc))
  return last
}

export async function moveNpc(c: AdminCall, raw: string): Promise<{ message: string; data: unknown }> {
  const npc = code(raw, 'the NPC code')
  const o = body(await c.body(), ['x', 'z', 'yaw'])
  const yaw = num(o, 'yaw', -Math.PI * 4, Math.PI * 4, true)
  const hasPoint = o.x !== undefined || o.z !== undefined
  if (!hasPoint && yaw === undefined) throw bad('give x and z, a yaw, or both')
  const before = npcByCode(c, npc)
  const to = hasPoint ? { ...groundAt(c.ctx, num(o, 'x', -COORD_MAX, COORD_MAX), num(o, 'z', -COORD_MAX, COORD_MAX)), ...(yaw !== undefined ? { yaw } : {}) } : { yaw: yaw! }
  const r = result(placeNpcAt(c.ctx, npc, to))
  c.audit('npc.move', `npc:${npc}`, before && { x: before.x, z: before.z, yaw: before.yaw }, o)
  return r
}

async function npcSimple(c: AdminCall, raw: string | null, what: 'remove' | 'restore' | 'undo'): Promise<{ message: string; data: unknown }> {
  body((await c.body()) ?? {}, [])
  const npc = raw === null ? null : code(raw, 'the NPC code')
  if (npc && what === 'restore' && AUTHORED_NPC_CODE.test(npc)) throw conflict('Only exported NPCs can be restored (authored NPCs: undo).')
  const before = npc === null ? null : npcByCode(c, npc)
  const r = npcEdits[what]({ ctx: c.ctx, args: npc === null ? [what] : [what, npc] })
  c.audit(`npc.${what}`, npc === null ? 'npcs' : `npc:${npc}`, before, null, r.ok, r.message.split('\n')[0])
  return result(r)
}

export const removeNpc = (c: AdminCall, code: string) => npcSimple(c, code, 'remove')
export const restoreNpc = (c: AdminCall, code: string) => npcSimple(c, code, 'restore')
export const undoNpcs = (c: AdminCall) => npcSimple(c, null, 'undo')

// ---- quests (the GM quest editor's routes, as the admin) ---------------------------------------------------------

export function listQuests(c: AdminCall): AdminPage<AdminQuestRow> {
  const { page, size } = paging(c.query)
  const q = search(c.query).toLowerCase()
  const rows = questEntries(c.ctx)
    .filter((x) => !q || x.id.toLowerCase().includes(q) || x.title.toLowerCase().includes(q))
    .map(({ raw: _raw, ...row }) => row)
    .sort((a, b) => a.id.localeCompare(b.id))
  return pageOf(rows, page, size)
}

export function questDetail(c: AdminCall, id: string): AdminQuestDetail {
  if (!QUEST_ID.test(id)) throw bad('quest ids are A-Z, 0-9 and _')
  const e = questEntries(c.ctx).find((x) => x.id === id)
  if (!e) throw notFound(`no quest ${id}`)
  const { raw, ...row } = e
  return { ...row, quest: raw }
}

/** PUT / DELETE / disable / enable: the quest editor's own route with the admin as the actor (gm_audit rows too). */
export async function questEdit(c: AdminCall, kind: 'PUT' | 'DELETE' | 'disable' | 'enable', id: string): Promise<unknown> {
  const method = kind === 'disable' || kind === 'enable' ? 'POST' : kind
  const path = `/api/gm/quests/${encodeURIComponent(id)}${kind === 'disable' || kind === 'enable' ? `/${kind}` : ''}`
  const r = questRoute(method, path)
  if (r === null) throw notFound('no such endpoint')
  let sent: unknown
  const res = await runQuestEditor(
    c.ctx,
    { id: c.admin.id, username: c.admin.username, role: 'admin' },
    method,
    path,
    r,
    async (limit) => (sent = await c.body(Math.min(limit, GM_API_MAX_BODY_BYTES))),
    () => {
      const a = c.ctx.store.accountById(c.admin.id)
      return a && a.role === 'admin' ? { id: a.id, username: a.username, role: a.role } : null
    },
    c.now,
  )
  const ok = res.status < 300
  c.audit(`quest.${kind.toLowerCase()}`, `quest:${id}`, undefined, kind === 'PUT' ? sent : undefined, ok, `HTTP ${res.status}`)
  if (!ok) {
    const b = res.body as { message?: string; issues?: { path: string; message: string }[] }
    const msg = b.message ?? b.issues?.filter((i) => i).map((i) => `${i.path}: ${i.message}`).slice(0, 5).join('; ') ?? `HTTP ${res.status}`
    // 409 and 422 keep their issues for the form (the panel shows them).
    throw new AdminError(res.status, (res.body as { error?: 'bad_request' }).error ?? 'bad_request', msg, b.issues ? { issues: b.issues } : undefined)
  }
  return res.body
}

// ---- unique bosses --------------------------------------------------------------------------------------------

interface UniqueListRow {
  code: string
  phase: 'alive' | 'waiting'
  id?: number
  camp?: number | null
  area?: string
  hpPct?: number
  dueAt?: number
  lastKiller?: string | null
  lastKilledAt?: number | null
  spawns?: number
}

export function uniquesView(c: AdminCall): AdminUniquesView {
  const u = c.ctx.gameplay.uniques
  if (!u) return { enabled: false, uniques: [] }
  const list = (u.gm(null, ['list']).data as { uniques?: UniqueListRow[] } | undefined)?.uniques ?? []
  return {
    enabled: true,
    uniques: list.map((r) => {
      const t = u.uniques.find((x) => x.def.mob === r.code)
      const mob = c.ctx.data.mob(r.code)
      return {
        code: r.code,
        icon: mobIcon(c.ctx, r.code),
        name: mob?.name ?? null,
        phase: r.phase,
        id: r.id ?? null,
        camp: r.camp ?? t?.row.camp ?? null,
        area: r.area ?? '',
        hpPct: r.hpPct ?? null,
        dueAt: r.phase === 'waiting' ? (r.dueAt ?? 0) : null,
        lastKiller: r.lastKiller ?? t?.row.last_killer ?? null,
        lastKilledAt: r.lastKilledAt ?? t?.row.last_killed_at ?? null,
        spawns: r.spawns ?? t?.row.spawns ?? 0,
        camps: t ? u.camps(t.def).map((n) => n.id) : [],
      }
    }),
  }
}

export async function uniqueAction(c: AdminCall, raw: string, action: 'spawn' | 'kill' | 'despawn' | 'timer'): Promise<{ message: string; data: unknown; uniques: AdminUniquesView }> {
  const u = c.ctx.gameplay.uniques
  if (!u) throw conflict('Uniques are off on this server (UNIQUES=off).')
  const mob = code(raw, 'the unique code')
  if (!u.uniques.some((x) => x.def.mob === mob)) throw notFound(`no unique ${mob}`)
  const o = body((await c.body()) ?? {}, action === 'spawn' ? ['camp'] : action === 'timer' ? ['minutes'] : [])
  const args = [action, mob]
  if (action === 'spawn' && o.camp !== undefined) args.push('camp', String(int(o, 'camp', 0, Number.MAX_SAFE_INTEGER)))
  if (action === 'timer') {
    const m = o.minutes
    if (m === 'now' || m === 'clear') args.push(m)
    else if (typeof m === 'number' && Number.isFinite(m) && m >= 0 && m <= 7 * 24 * 60) args.push(String(m))
    else throw bad("minutes must be 0-10080, 'now' or 'clear'")
  }
  const r = u.gm(null, args)
  c.audit(`unique.${action}`, `unique:${mob}`, undefined, args.slice(2), r.ok, r.message.split('\n')[0])
  const out = result(r)
  return { ...out, uniques: uniquesView(c) }
}
