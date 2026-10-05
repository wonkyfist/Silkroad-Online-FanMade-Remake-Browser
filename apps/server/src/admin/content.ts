import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  ADMIN_CONTENT_BODY_MAX_BYTES,
  ADMIN_ITEM_FLAG_FIELDS,
  ADMIN_ITEM_NUMBER_FIELDS,
  ADMIN_ITEM_STAT_FIELDS,
  ADMIN_ITEM_USE_FIELDS,
  CODE_NAME,
  MAX_GOLD,
  MAX_ITEM_COUNT,
  checkDropTable,
  checkItemDef,
  cleanQuestText,
  codePointLength,
  type AdminDropDetail,
  type AdminDropRow,
  type AdminItemDetail,
  type AdminItemPatch,
  type AdminItemRow,
  type AdminMobRow,
  type AdminPage,
  type DropTable,
  type ItemDef,
} from '@sro/shared'
import type { GameContext } from '../game.ts'
import type { GameData } from '../gamedata.ts'
import { contentRoot, readJsonFile, saveVersioned } from '../editors/overrides.ts'
import type { AdminCall } from './call.ts'
import { itemIcon, mobIcon } from './icons.ts'
import { bad, body, conflict, isObj, notFound, pageOf, paging, search, type Obj } from './http.ts'

/**
 * The item and drop override layers (docs/ADMIN.md §5): DATA_DIR/content/items.override.json patches exported items
 * field by field, DATA_DIR/content/drops.override.json replaces a monster's exported drop table. The export itself is
 * never written. Same file conventions as the GM editors (editors/overrides.ts: atomic write, history copies, rev);
 * layered at start (game.ts, before Gameplay) and on every save. A bad record is skipped with a log line, never fatal.
 */

export const ITEMS_OVERRIDE_FILE = 'items.override.json'
export const DROPS_OVERRIDE_FILE = 'drops.override.json'
/** Most patched items / replaced drop tables per file. */
export const CONTENT_OVERRIDE_MAX = 5000
const NAME_MAX = 64
const STAT_MAX = 1_000_000
const DROP_GROUPS_MAX = 50
const DROP_ENTRIES_MAX = 200

export type ItemPatchRecord = AdminItemPatch & { code: string }

export interface ItemsOverrideFile {
  schema: 1
  kind: 'items-override'
  rev: number
  updatedAt: string
  patch: ItemPatchRecord[]
}

export interface DropsOverrideFile {
  schema: 1
  kind: 'drops-override'
  rev: number
  updatedAt: string
  tables: DropTable[]
}

interface Layer {
  root: string
  outDir: string
  baseItems: Map<string, ItemDef>
  baseDrops: Map<string, DropTable>
  items: ItemsOverrideFile
  drops: DropsOverrideFile
  /** The merged items.json the game client reads, per items rev. */
  merged: { rev: number; mtimeMs: number; json: Buffer; gz: Buffer } | null
}

const LAYERS = new WeakMap<GameData, Layer>()

const emptyItems = (): ItemsOverrideFile => ({ schema: 1, kind: 'items-override', rev: 0, updatedAt: '', patch: [] })
const emptyDrops = (): DropsOverrideFile => ({ schema: 1, kind: 'drops-override', rev: 0, updatedAt: '', tables: [] })

// ---- checks -----------------------------------------------------------------------------------------------------

const isRange = (v: unknown, lo: number, hi: number): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi) && v[0] <= v[1]

const NUMBER_BOUNDS: Record<(typeof ADMIN_ITEM_NUMBER_FIELDS)[number], [number, number, boolean]> = {
  price: [0, MAX_GOLD, true],
  sellPrice: [0, MAX_GOLD, true],
  reqLevel: [0, 300, true],
  maxStack: [1, MAX_ITEM_COUNT, true],
  degree: [0, 30, true],
  keepFee: [0, MAX_GOLD, true],
  repairCost: [0, MAX_GOLD, true],
}

/** A clean item patch for `base`, or its problems. */
export function checkItemPatch(v: unknown, base: ItemDef): { patch: AdminItemPatch } | { problems: string[] } {
  if (!isObj(v)) return { problems: ['the patch must be an object'] }
  const p: string[] = []
  const out: AdminItemPatch = {}
  const allowed = new Set<string>(['name', ...ADMIN_ITEM_NUMBER_FIELDS, ...ADMIN_ITEM_FLAG_FIELDS, 'stats', 'use'])
  for (const k of Object.keys(v)) if (!allowed.has(k)) p.push(`${k}: not editable`)
  if (v.name !== undefined) {
    const name = typeof v.name === 'string' ? cleanQuestText(v.name).replace(/\s+/g, ' ').trim() : ''
    if (!name || codePointLength(name) > NAME_MAX) p.push(`name: 1-${NAME_MAX} characters`)
    else out.name = name
  }
  for (const k of ADMIN_ITEM_NUMBER_FIELDS) {
    const x = v[k]
    if (x === undefined) continue
    const [lo, hi, integer] = NUMBER_BOUNDS[k]
    if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi || (integer && !Number.isInteger(x))) p.push(`${k}: a whole number ${lo}-${hi}`)
    else out[k] = x
  }
  if (out.maxStack !== undefined && out.maxStack > 1 && base.slot !== undefined) p.push('maxStack: equipment does not stack')
  for (const k of ADMIN_ITEM_FLAG_FIELDS) {
    const x = v[k]
    if (x === undefined) continue
    if (typeof x !== 'boolean') p.push(`${k}: true or false`)
    else out[k] = x
  }
  if (v.stats !== undefined) {
    if (!isObj(v.stats)) p.push('stats: an object of [min, max] ranges')
    else {
      const stats: NonNullable<AdminItemPatch['stats']> = {}
      for (const [k, x] of Object.entries(v.stats)) {
        if (!(ADMIN_ITEM_STAT_FIELDS as readonly string[]).includes(k)) p.push(`stats.${k}: unknown stat`)
        else if (!isRange(x, 0, STAT_MAX)) p.push(`stats.${k}: [min, max] with 0 <= min <= max <= ${STAT_MAX}`)
        else stats[k as (typeof ADMIN_ITEM_STAT_FIELDS)[number]] = [x[0], x[1]]
      }
      if (Object.keys(stats).length) out.stats = stats
    }
  }
  if (v.use !== undefined) {
    if (!base.use) p.push('use: only usable items (potions, scrolls) have use effects')
    else if (!isObj(v.use)) p.push('use: an object')
    else {
      const use: NonNullable<AdminItemPatch['use']> = {}
      for (const [k, x] of Object.entries(v.use)) {
        if (!(ADMIN_ITEM_USE_FIELDS as readonly string[]).includes(k)) p.push(`use.${k}: not editable`)
        else {
          const hi = k === 'hpPct' || k === 'mpPct' ? 100 : k === 'cooldownMs' ? 3_600_000 : STAT_MAX
          if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > hi) p.push(`use.${k}: 0-${hi}`)
          else use[k as (typeof ADMIN_ITEM_USE_FIELDS)[number]] = x
        }
      }
      if (Object.keys(use).length) out.use = use
    }
  }
  if (p.length === 0 && Object.keys(out).length === 0) p.push('the patch changes nothing')
  return p.length ? { problems: p } : { patch: out }
}

/** The exported item with a patch applied (stats and use merged per field). */
export function patchedItem(base: ItemDef, patch: AdminItemPatch): ItemDef {
  const { stats, use, ...rest } = patch
  const out: ItemDef = { ...base, ...rest }
  if (stats) out.stats = { ...base.stats, ...stats }
  if (use && base.use) out.use = { ...base.use, ...use }
  return out
}

/** A clean drop table for `mob`, or its problems (known items only, bounded sizes). */
export function checkDropOverride(v: unknown, mob: string, data: GameData): { table: DropTable } | { problems: string[] } {
  if (!isObj(v)) return { problems: ['the table must be an object'] }
  const raw = { ...v, mob, provenance: 'authored' }
  const p = [...checkDropTable(raw, 'table')]
  for (const k of Object.keys(v)) if (!['mob', 'gold', 'groups', 'provenance'].includes(k)) p.push(`table.${k}: unexpected field`)
  if (v.mob !== undefined && v.mob !== mob) p.push(`table.mob: must be ${mob}`)
  const gold = v.gold
  if (isObj(gold) && (!(typeof gold.chance === 'number' && gold.chance >= 0 && gold.chance <= 1) || !isRange(gold.amount, 0, MAX_GOLD))) p.push('table.gold: {chance 0-1, amount [min, max]}')
  const groups = Array.isArray(v.groups) ? v.groups : []
  if (groups.length > DROP_GROUPS_MAX) p.push(`table.groups: at most ${DROP_GROUPS_MAX}`)
  groups.forEach((g, i) => {
    if (!isObj(g) || !Array.isArray(g.entries)) return
    if (!(typeof g.chance === 'number' && g.chance >= 0 && g.chance <= 1)) p.push(`table.groups[${i}].chance: 0-1`)
    if (g.entries.length === 0 || g.entries.length > DROP_ENTRIES_MAX) p.push(`table.groups[${i}].entries: 1-${DROP_ENTRIES_MAX}`)
    for (const k of Object.keys(g)) if (k !== 'chance' && k !== 'entries') p.push(`table.groups[${i}].${k}: unexpected field`)
    g.entries.forEach((e, j) => {
      if (!isObj(e)) return
      const where = `table.groups[${i}].entries[${j}]`
      if (typeof e.item === 'string' && !data.items.has(e.item)) p.push(`${where}.item: no item ${e.item}`)
      if (!(typeof e.weight === 'number' && e.weight > 0 && e.weight <= 1e6)) p.push(`${where}.weight: above 0`)
      if (e.count !== undefined && !isRange(e.count, 1, MAX_ITEM_COUNT)) p.push(`${where}.count: [min, max] from 1`)
      for (const k of Object.keys(e)) if (!['item', 'weight', 'count'].includes(k)) p.push(`${where}.${k}: unexpected field`)
    })
  })
  if (p.length) return { problems: p }
  const table: DropTable = {
    mob,
    ...(isObj(gold) ? { gold: { chance: gold.chance as number, amount: [(gold.amount as number[])[0], (gold.amount as number[])[1]] } } : {}),
    groups: groups.map((g: Obj) => ({
      chance: g.chance as number,
      entries: (g.entries as Obj[]).map((e) => ({ item: e.item as string, weight: e.weight as number, ...(e.count ? { count: [(e.count as number[])[0], (e.count as number[])[1]] as [number, number] } : {}) })),
    })),
    provenance: 'authored',
  }
  return { table }
}

// ---- files and layering --------------------------------------------------------------------------------------

function readItems(file: string, base: Map<string, ItemDef>, log: (m: string) => void): ItemsOverrideFile {
  const r = readJsonFile(file)
  if ('missing' in r) return emptyItems()
  if ('error' in r || !isObj(r.json) || r.json.schema !== 1 || r.json.kind !== 'items-override' || !Array.isArray(r.json.patch)) {
    log(`content override items: skipped ${file}: ${'error' in r ? r.error : 'not an items-override file'}`)
    return emptyItems()
  }
  const out: ItemsOverrideFile = { ...emptyItems(), rev: Number.isSafeInteger(r.json.rev) ? (r.json.rev as number) : 0, updatedAt: String(r.json.updatedAt ?? '').slice(0, 64) }
  for (const [i, rec] of (r.json.patch as unknown[]).slice(0, CONTENT_OVERRIDE_MAX).entries()) {
    const code = isObj(rec) ? rec.code : undefined
    const def = typeof code === 'string' ? base.get(code) : undefined
    if (!def || !isObj(rec)) {
      log(`content override items: skipped patch[${i}]: no exported item ${String(code)}`)
      continue
    }
    const { code: _c, ...fields } = rec
    const c = checkItemPatch(fields, def)
    if ('problems' in c) log(`content override items: skipped patch[${i}] ${def.code}: ${c.problems.join('; ')}`)
    else if (out.patch.some((x) => x.code === def.code)) log(`content override items: skipped patch[${i}]: duplicate ${def.code}`)
    else out.patch.push({ code: def.code, ...c.patch })
  }
  return out
}

function readDrops(file: string, data: GameData, log: (m: string) => void): DropsOverrideFile {
  const r = readJsonFile(file)
  if ('missing' in r) return emptyDrops()
  if ('error' in r || !isObj(r.json) || r.json.schema !== 1 || r.json.kind !== 'drops-override' || !Array.isArray(r.json.tables)) {
    log(`content override drops: skipped ${file}: ${'error' in r ? r.error : 'not a drops-override file'}`)
    return emptyDrops()
  }
  const out: DropsOverrideFile = { ...emptyDrops(), rev: Number.isSafeInteger(r.json.rev) ? (r.json.rev as number) : 0, updatedAt: String(r.json.updatedAt ?? '').slice(0, 64) }
  for (const [i, t] of (r.json.tables as unknown[]).slice(0, CONTENT_OVERRIDE_MAX).entries()) {
    const mob = isObj(t) ? t.mob : undefined
    if (typeof mob !== 'string' || !data.mob(mob)) {
      log(`content override drops: skipped tables[${i}]: no monster ${String(mob)}`)
      continue
    }
    const c = checkDropOverride(t, mob, data)
    if ('problems' in c) log(`content override drops: skipped tables[${i}] ${mob}: ${c.problems.slice(0, 3).join('; ')}`)
    else if (out.tables.some((x) => x.mob === mob)) log(`content override drops: skipped tables[${i}]: duplicate ${mob}`)
    else out.tables.push(c.table)
  }
  return out
}

function apply(data: GameData, L: Layer): void {
  for (const [code, def] of L.baseItems) data.items.set(code, def)
  for (const p of L.items.patch) {
    const base = L.baseItems.get(p.code)
    if (base) data.items.set(p.code, patchedItem(base, p))
  }
  data.drops.clear()
  for (const [mob, t] of L.baseDrops) data.drops.set(mob, t)
  for (const t of L.drops.tables) data.drops.set(t.mob, t)
  L.merged = null
}

/**
 * Startup (game.ts, right after GameData.load): reads both override files from DATA_DIR/content and layers them over
 * the exported items and drop tables. Never throws.
 */
export function layerAdminContent(data: GameData, dataDir: string, outDir: string, log: (m: string) => void): void {
  if (LAYERS.has(data)) return
  const root = contentRoot(dataDir)
  const L: Layer = { root, outDir, baseItems: new Map(data.items), baseDrops: new Map(data.drops), items: emptyItems(), drops: emptyDrops(), merged: null }
  L.items = readItems(join(root, ITEMS_OVERRIDE_FILE), L.baseItems, log)
  L.drops = readDrops(join(root, DROPS_OVERRIDE_FILE), data, log)
  LAYERS.set(data, L)
  apply(data, L)
  if (L.items.patch.length || L.drops.tables.length) log(`content overrides (${root}): ${L.items.patch.length} items patched (rev ${L.items.rev}), ${L.drops.tables.length} drop tables replaced (rev ${L.drops.rev})`)
}

function layer(ctx: GameContext): Layer {
  layerAdminContent(ctx.data, ctx.config.dataDir, ctx.config.outDir, ctx.config.log)
  return LAYERS.get(ctx.data)!
}

/** After an item change: shops rebuild their lists, online players wearing the item get their stats recomputed. */
function itemsChanged(ctx: GameContext, code: string): void {
  for (const s of ctx.data.shops.values()) for (const n of s.npcs) ctx.gameplay.shops.forgetGoods(n)
  for (const n of ctx.data.npcShop.keys()) ctx.gameplay.shops.forgetGoods(n)
  for (const p of ctx.world.players.values()) {
    if (!Object.values(p.equip).some((s) => s?.code === code)) continue
    ctx.gameplay.refresh(p)
    p.send({ t: 'stats', stats: ctx.gameplay.stats(p) })
  }
}

// ---- the client's items.json -----------------------------------------------------------------------------------

/**
 * The game client's /out/data/items.json with the item overrides merged in (game.ts serves it in place of the file
 * when there are overrides, so tooltips, names and prices match the server). null = serve the file as it is.
 */
export function mergedItemsJson(ctx: GameContext): { etag: string; json: Buffer; gz: Buffer } | null {
  const L = LAYERS.get(ctx.data)
  if (!L || L.items.patch.length === 0) return null
  const file = join(L.outDir, 'data', 'items.json')
  let text: string
  let mtimeMs = 0
  try {
    mtimeMs = Math.floor(statSync(file).mtimeMs)
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  if (!L.merged || L.merged.rev !== L.items.rev || L.merged.mtimeMs !== mtimeMs) {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return null
    }
    const patched = new Map(L.items.patch.map((p) => [p.code, p]))
    const swap = (e: unknown) => (isObj(e) && typeof e.code === 'string' && patched.has(e.code) ? (ctx.data.items.get(e.code) ?? e) : e)
    const out = Array.isArray(json) ? json.map(swap) : isObj(json) && Array.isArray(json.entries) ? { ...json, entries: json.entries.map(swap) } : json
    const buf = Buffer.from(JSON.stringify(out))
    L.merged = { rev: L.items.rev, mtimeMs, json: buf, gz: gzipSync(buf, { level: 6 }) }
  }
  return { etag: `"items-ov${L.items.rev}-${mtimeMs.toString(16)}"`, json: L.merged.json, gz: L.merged.gz }
}

// ---- items API -------------------------------------------------------------------------------------------------

export function listItems(c: AdminCall): AdminPage<AdminItemRow> {
  const L = layer(c.ctx)
  const { page, size } = paging(c.query)
  const q = search(c.query).toLowerCase()
  const category = c.query.get('category') ?? ''
  const onlyOverridden = c.query.get('overridden') === '1'
  const patched = new Set(L.items.patch.map((p) => p.code))
  const rows: AdminItemRow[] = []
  for (const def of c.ctx.data.items.values()) {
    if (q && !def.code.toLowerCase().includes(q) && !(def.name ?? '').toLowerCase().includes(q)) continue
    if (category && def.category !== category) continue
    if (onlyOverridden && !patched.has(def.code)) continue
    rows.push({ code: def.code, name: def.name, category: def.category, slot: def.slot ?? null, degree: def.degree, reqLevel: def.reqLevel, price: def.price, icon: null, overridden: patched.has(def.code) })
  }
  rows.sort((a, b) => a.degree - b.degree || (a.name ?? a.code).localeCompare(b.name ?? b.code) || a.code.localeCompare(b.code))
  const out = pageOf(rows, page, size)
  for (const r of out.rows) r.icon = itemIcon(c.ctx, r.code)
  return out
}

function itemCode(raw: string): string {
  const code = raw.trim().toUpperCase()
  if (!CODE_NAME.test(code)) throw bad('malformed item code')
  return code
}

export function itemDetail(c: AdminCall, raw: string): AdminItemDetail {
  const L = layer(c.ctx)
  const code = itemCode(raw)
  const base = L.baseItems.get(code)
  if (!base) throw notFound(`no item ${code}`)
  const rec = L.items.patch.find((p) => p.code === code)
  const { code: _c, ...patch } = rec ?? { code }
  return { base, effective: c.ctx.data.items.get(code) ?? base, icon: itemIcon(c.ctx, code, base), patch: rec ? patch : null, rev: L.items.rev }
}

function saveItems(c: AdminCall, L: Layer, next: ItemPatchRecord[]): void {
  const file: ItemsOverrideFile = { schema: 1, kind: 'items-override', rev: L.items.rev + 1, updatedAt: new Date(c.now).toISOString(), patch: next }
  saveVersioned(L.root, ITEMS_OVERRIDE_FILE, L.items, file)
  L.items = file
  apply(c.ctx.data, L)
}

export async function putItem(c: AdminCall, raw: string): Promise<AdminItemDetail> {
  const L = layer(c.ctx)
  const code = itemCode(raw)
  const base = L.baseItems.get(code)
  if (!base) throw notFound(`no item ${code}`)
  const o = body(await c.body(ADMIN_CONTENT_BODY_MAX_BYTES), ['patch', 'baseRev'])
  if (o.baseRev !== undefined && o.baseRev !== L.items.rev) throw conflict(`the item overrides changed meanwhile (rev ${L.items.rev}); reload and apply your edit again`)
  const r = checkItemPatch(o.patch, base)
  if ('problems' in r) throw bad(r.problems.join('; '))
  const effective = patchedItem(base, r.patch)
  const sanity = checkItemDef(effective, code)
  if (sanity.length) throw bad(sanity.slice(0, 3).join('; '))
  const before = L.items.patch.find((p) => p.code === code) ?? null
  if (L.items.patch.length >= CONTENT_OVERRIDE_MAX && !before) throw bad(`at most ${CONTENT_OVERRIDE_MAX} patched items`)
  saveItems(c, L, [...L.items.patch.filter((p) => p.code !== code), { code, ...r.patch }])
  itemsChanged(c.ctx, code)
  c.audit('item.put', `item:${code}`, before, { code, ...r.patch })
  c.ctx.config.log(`admin ${c.admin.username}: item override ${code} (rev ${L.items.rev})`)
  return itemDetail(c, code)
}

export async function deleteItem(c: AdminCall, raw: string): Promise<AdminItemDetail> {
  const L = layer(c.ctx)
  const code = itemCode(raw)
  if (!L.baseItems.has(code)) throw notFound(`no item ${code}`)
  const before = L.items.patch.find((p) => p.code === code)
  if (!before) throw notFound(`${code} has no override`)
  saveItems(c, L, L.items.patch.filter((p) => p.code !== code))
  itemsChanged(c.ctx, code)
  c.audit('item.revert', `item:${code}`, before, null)
  return itemDetail(c, code)
}

// ---- drops API ------------------------------------------------------------------------------------------------

function uniqueNote(ctx: GameContext, mob: string): string | null {
  const u = ctx.gameplay.uniques
  return u && u.uniques.some((x) => x.def.mob === mob) ? 'A world boss: its loot comes from content/uniques.json while UNIQUES is on, not from this table.' : null
}

export function listDrops(c: AdminCall): AdminPage<AdminDropRow> {
  const L = layer(c.ctx)
  const { page, size } = paging(c.query)
  const q = search(c.query).toLowerCase()
  const onlyOverridden = c.query.get('overridden') === '1'
  const replaced = new Set(L.drops.tables.map((t) => t.mob))
  const rows: AdminDropRow[] = []
  for (const mob of c.ctx.data.mobs.values()) {
    const t = c.ctx.data.drops.get(mob.code)
    if (q && !mob.code.toLowerCase().includes(q) && !(mob.name ?? '').toLowerCase().includes(q)) continue
    if (onlyOverridden && !replaced.has(mob.code)) continue
    if (!t && !q) continue
    rows.push({
      mob: mob.code, mobName: mob.name ?? null, icon: null, level: mob.level, groups: t?.groups.length ?? 0,
      items: t ? t.groups.reduce((n, g) => n + g.entries.length, 0) : 0, gold: !!t?.gold, overridden: replaced.has(mob.code),
    })
  }
  rows.sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || (a.mobName ?? a.mob).localeCompare(b.mobName ?? b.mob))
  const out = pageOf(rows, page, size)
  for (const r of out.rows) r.icon = mobIcon(c.ctx, r.mob)
  return out
}

/** Name and icon of every item the given tables name (the drop editor shows them). */
function dropItems(ctx: GameContext, tables: (DropTable | undefined)[]): AdminDropDetail['items'] {
  const out: AdminDropDetail['items'] = {}
  for (const t of tables) for (const g of t?.groups ?? []) for (const e of g.entries) out[e.item] ??= { name: ctx.data.item(e.item)?.name ?? null, icon: itemIcon(ctx, e.item) }
  return out
}

function mobCode(c: AdminCall, raw: string): string {
  const mob = raw.trim().toUpperCase()
  if (!CODE_NAME.test(mob)) throw bad('malformed monster code')
  if (!c.ctx.data.mob(mob)) throw notFound(`no monster ${mob}`)
  return mob
}

export function dropDetail(c: AdminCall, raw: string): AdminDropDetail {
  const L = layer(c.ctx)
  const mob = mobCode(c, raw)
  const def = c.ctx.data.mob(mob)
  return {
    mob, mobName: def?.name ?? null, level: def?.level ?? null, base: L.baseDrops.get(mob) ?? null, effective: c.ctx.data.drops.get(mob) ?? null,
    overridden: L.drops.tables.some((t) => t.mob === mob), rev: L.drops.rev, note: uniqueNote(c.ctx, mob),
    icon: mobIcon(c.ctx, mob), items: dropItems(c.ctx, [L.baseDrops.get(mob), c.ctx.data.drops.get(mob)]),
  }
}

function saveDrops(c: AdminCall, L: Layer, next: DropTable[]): void {
  const file: DropsOverrideFile = { schema: 1, kind: 'drops-override', rev: L.drops.rev + 1, updatedAt: new Date(c.now).toISOString(), tables: next }
  saveVersioned(L.root, DROPS_OVERRIDE_FILE, L.drops, file)
  L.drops = file
  apply(c.ctx.data, L)
}

export async function putDrop(c: AdminCall, raw: string): Promise<AdminDropDetail> {
  const L = layer(c.ctx)
  const mob = mobCode(c, raw)
  const o = body(await c.body(ADMIN_CONTENT_BODY_MAX_BYTES), ['table'])
  const r = checkDropOverride(o.table, mob, c.ctx.data)
  if ('problems' in r) throw bad(r.problems.slice(0, 8).join('; '))
  const before = c.ctx.data.drops.get(mob) ?? null
  if (L.drops.tables.length >= CONTENT_OVERRIDE_MAX && !L.drops.tables.some((t) => t.mob === mob)) throw bad(`at most ${CONTENT_OVERRIDE_MAX} replaced drop tables`)
  saveDrops(c, L, [...L.drops.tables.filter((t) => t.mob !== mob), r.table])
  c.audit('drop.put', `drop:${mob}`, before, r.table)
  c.ctx.config.log(`admin ${c.admin.username}: drop table override ${mob} (rev ${L.drops.rev})`)
  return dropDetail(c, mob)
}

export async function deleteDrop(c: AdminCall, raw: string): Promise<AdminDropDetail> {
  const L = layer(c.ctx)
  const mob = mobCode(c, raw)
  const before = L.drops.tables.find((t) => t.mob === mob)
  if (!before) throw notFound(`${mob} has no override`)
  saveDrops(c, L, L.drops.tables.filter((t) => t.mob !== mob))
  c.audit('drop.revert', `drop:${mob}`, before, L.baseDrops.get(mob) ?? null)
  return dropDetail(c, mob)
}

// ---- pickers -----------------------------------------------------------------------------------------------------

export function listMobs(c: AdminCall): AdminPage<AdminMobRow> {
  const { page, size } = paging(c.query, 20)
  const q = search(c.query).toLowerCase()
  const rows: AdminMobRow[] = []
  for (const m of c.ctx.data.mobs.values()) {
    if (q && !m.code.toLowerCase().includes(q) && !(m.name ?? '').toLowerCase().includes(q)) continue
    rows.push({ code: m.code, name: m.name ?? null, level: m.level, rarity: m.rarity ?? 'normal', icon: null })
  }
  rows.sort((a, b) => a.level - b.level || (a.name ?? a.code).localeCompare(b.name ?? b.code))
  const out = pageOf(rows, page, size)
  for (const r of out.rows) r.icon = mobIcon(c.ctx, r.code)
  return out
}

export function listShops(c: AdminCall): { shops: { id: string; npcs: string[]; items: number }[] } {
  return { shops: [...c.ctx.data.shops.values()].map((s) => ({ id: s.id, npcs: [...s.npcs], items: s.tabs.reduce((n, t) => n + t.items.length, 0) })).sort((a, b) => a.id.localeCompare(b.id)) }
}
