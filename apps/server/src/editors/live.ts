import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ContentChangeKind, NestDef, NpcDef } from '@sro/shared'
import type { GameContext } from '../game.ts'
import type { GmCall, GmResult } from '../gm.ts'
import { HIDDEN_NPCS } from '../npc.ts'
import type { NestRuntime } from '../spawner.ts'
import {
  applyLayers,
  contentState,
  editorAllowed,
  listHistory,
  NESTS_OVERRIDE_FILE,
  NPCS_OVERRIDE_FILE,
  QUEST_OVERRIDE_DIR,
  readOverride,
  saveVersioned,
  writeJsonAtomic,
  type ContentState,
  type NestOverrideFile,
  type NpcOverrideFile,
} from './overrides.ts'

/**
 * The live side of the GM content editors (docs/QUESTS.md §5; lane ED-S): commits an override file (history copy, atomic
 * write), re-layers GameData, applies the difference to the running world (spawner nests, NPC entities, shop links) and
 * tells every player in the world with `contentChanged`. Also the `content` GM command (reload / status).
 */

export const ok = (message: string, data?: unknown): GmResult => (data === undefined ? { ok: true, message } : { ok: true, message, data })
export const fail = (message: string): GmResult => ({ ok: false, message })

/** The content state of this server (layered at startup by game.ts; created on first use otherwise). */
export function editorState(ctx: GameContext): ContentState {
  return contentState(ctx.data, ctx.config.dataDir, ctx.config.world, ctx.config.log)
}

/** The EDITOR_ROLE gate on top of the GM check runGm already made (decision 48). null when allowed. */
export function editorRefusal(g: GmCall): GmResult | null {
  if (editorAllowed(g.role, g.ctx.config.editorRole)) return null
  return fail(`The content editors are limited to the ${g.ctx.config.editorRole ?? 'gm'} role on this server (EDITOR_ROLE).`)
}

/** `contentChanged {kind, rev}` to everyone in the world. */
export function broadcastContent(ctx: GameContext, kind: ContentChangeKind, rev: number): void {
  for (const p of ctx.world.players.values()) p.send({ t: 'contentChanged', kind, rev })
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function fmt(n: number): string {
  return round1(n).toFixed(1)
}

// ---- nests ------------------------------------------------------------------------------------------------

/** Idle mobs first (they go first when a nest shrinks), fighting ones last. */
function idleFirst(ctx: GameContext): (ids: number[]) => number[] {
  const rank = (id: number): number => {
    const m = ctx.world.mobs.get(id)
    if (!m) return -1
    return m.ai === 'idle' && m.target === null ? 0 : 1
  }
  return (ids) => [...ids].sort((a, b) => rank(a) - rank(b))
}

/** The living mobs of `nest` take its new roam radius and tactics (docs/QUESTS.md §5.2). */
function retune(ctx: GameContext, nest: NestRuntime): void {
  const def = nest.def
  for (const id of nest.alive) {
    const m = ctx.world.mobs.get(id)
    if (!m || m.ai === 'dead') continue
    m.nest = def
    m.home = [def.x, def.z]
    m.roamRadius = def.radius
    m.sightRange = def.tactics.sightRange
    m.leashRange = Math.max(def.tactics.leashRange, def.radius + 10)
    m.aggressive = def.tactics.aggressive
  }
}

/** Applies the change from the effective nests `before` to `after` to the live spawner (only the nests that changed). */
export function applyNestDiff(ctx: GameContext, before: readonly NestDef[], after: readonly NestDef[], now = Date.now()): number {
  if (!ctx.config.spawnMobs) return 0
  const a = new Map(before.map((n) => [n.id, n]))
  const b = new Map(after.map((n) => [n.id, n]))
  let changed = 0
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id)
    const y = b.get(id)
    if (x === y || (x && y && JSON.stringify(x) === JSON.stringify(y))) continue
    changed++
    const r = ctx.gameplay.spawner.updateNest(id, y ?? null, idleFirst(ctx))
    ctx.gameplay.despawnNestMobs(r.despawn)
    if (r.nest) {
      retune(ctx, r.nest)
      ctx.gameplay.fillNest(r.nest, now)
    }
  }
  return changed
}

/** Writes the next nests override (a history copy of the current one first unless `undo`), then applies it live. */
export function commitNests(ctx: GameContext, next: NestOverrideFile, opts: { undo?: boolean } = {}): NestOverrideFile {
  const st = editorState(ctx)
  const prev = st.nests
  const file: NestOverrideFile = { ...next, rev: prev.rev + 1, updatedAt: new Date().toISOString() }
  if (opts.undo) writeJsonAtomic(join(st.root, NESTS_OVERRIDE_FILE), file)
  else saveVersioned(st.root, NESTS_OVERRIDE_FILE, prev, file)
  const before = [...ctx.data.nests]
  st.nests = file
  applyLayers(ctx.data, st)
  applyNestDiff(ctx, before, ctx.data.nests)
  broadcastContent(ctx, 'nests', file.rev)
  return file
}

/** A copy of the nests override to edit (the state's arrays are never mutated in place). */
export function draftNests(st: ContentState): NestOverrideFile {
  return { ...st.nests, add: st.nests.add.map((n) => ({ ...n, tactics: { ...n.tactics }, source: { ...n.source } })), patch: st.nests.patch.map((p) => ({ ...p })), remove: [...st.nests.remove] }
}

// ---- NPCs -------------------------------------------------------------------------------------------------

/** Drops the cached goods of `codes` so a changed shop link shows at once (shop.ts caches goods per NPC code). */
function forgetShopGoods(ctx: GameContext, codes: Iterable<string>): void {
  for (const c of codes) ctx.gameplay.shops.forgetGoods(c)
}

/** Applies the change from the effective NPCs `before` to `after` to the world (the changed NPCs are re-placed). */
export function applyNpcDiff(
  ctx: GameContext,
  before: { npcs: readonly NpcDef[]; model: ReadonlyMap<string, string>; shop: ReadonlyMap<string, string> },
  now = Date.now(),
): number {
  const world = ctx.config.world
  const live = (list: readonly NpcDef[]) => new Map(list.filter((n) => n.world === world && !HIDDEN_NPCS.includes(n.code)).map((n) => [n.code, n]))
  const a = live(before.npcs)
  const b = live(ctx.data.npcs)
  let changed = 0
  const shops = new Set<string>()
  for (const code of new Set([...a.keys(), ...b.keys()])) {
    if (before.shop.get(code) !== ctx.data.npcShop.get(code)) shops.add(code)
    const x = a.get(code)
    const y = b.get(code)
    const same = x === y || (x && y && JSON.stringify(x) === JSON.stringify(y) && before.model.get(code) === ctx.data.npcModel.get(code))
    if (same) continue
    changed++
    if (x) ctx.gameplay.removeNpc(code)
    if (y) ctx.gameplay.placeNpc(y, now)
  }
  forgetShopGoods(ctx, shops)
  return changed
}

function npcSnapshot(ctx: GameContext) {
  return { npcs: [...ctx.data.npcs], model: new Map(ctx.data.npcModel), shop: new Map(ctx.data.npcShop) }
}

/** Writes the next NPCs override (history copy first unless `undo`), then applies it live. */
export function commitNpcs(ctx: GameContext, next: NpcOverrideFile, opts: { undo?: boolean } = {}): NpcOverrideFile {
  const st = editorState(ctx)
  const prev = st.npcs
  const file: NpcOverrideFile = { ...next, rev: prev.rev + 1, updatedAt: new Date().toISOString() }
  if (opts.undo) writeJsonAtomic(join(st.root, NPCS_OVERRIDE_FILE), file)
  else saveVersioned(st.root, NPCS_OVERRIDE_FILE, prev, file)
  const before = npcSnapshot(ctx)
  st.npcs = file
  applyLayers(ctx.data, st)
  applyNpcDiff(ctx, before)
  broadcastContent(ctx, 'npcs', file.rev)
  return file
}

export function draftNpcs(st: ContentState): NpcOverrideFile {
  return { ...st.npcs, add: st.npcs.add.map((n) => ({ ...n })), patch: st.npcs.patch.map((p) => ({ ...p })) }
}

// ---- quests (hot reload through the quest engine, lane QS-S) ---------------------------------------------------

type Reloadable = { reloadContent?: () => unknown; book?: { reload?: () => unknown; rev?: unknown } }

const revValue = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)

/** Own revision counter for `contentChanged quests` when the quest engine exposes none. */
let questRev = 0

/**
 * Hot-reloads the quest catalog after an override file changed on disk (docs/QUESTS.md §5.4): QS-S's
 * `QuestEngine.reloadContent()` (which re-reads the files, re-maps the players' logs and sends `contentChanged
 * {kind: 'quests'}` itself), else `QuestBook.reload()` plus our own `contentChanged`. Returns the catalog revision.
 */
export function reloadQuests(ctx: GameContext): number {
  const engine = ctx.gameplay.quests as unknown as Reloadable
  try {
    if (typeof engine.reloadContent === 'function') {
      const rev = revValue(engine.reloadContent()) ?? revValue(engine.book?.rev)
      if (rev !== null) return rev
    } else if (typeof engine.book?.reload === 'function') engine.book.reload()
    else ctx.config.log('quest editor: the quest engine has no hot reload; the change applies after a restart')
  } catch (e) {
    ctx.config.log(`quest editor: hot reload failed: ${(e as Error).stack ?? e}`)
  }
  const rev = revValue(engine.book?.rev) ?? ++questRev
  broadcastContent(ctx, 'quests', rev)
  return rev
}

// ---- the `content` GM command -------------------------------------------------------------------------------

export const CONTENT_USAGE = 'content status | content reload [nests|npcs|quests|all]'

function reloadNests(ctx: GameContext): string {
  const st = editorState(ctx)
  const before = [...ctx.data.nests]
  const problems = readOverride(ctx.data, st, 'nests')
  applyLayers(ctx.data, st)
  const changed = applyNestDiff(ctx, before, ctx.data.nests)
  broadcastContent(ctx, 'nests', st.nests.rev)
  return `nests rev ${st.nests.rev}: ${changed} changed${problems.length ? `, ${problems.length} problems (first: ${problems[0]})` : ''}`
}

function reloadNpcs(ctx: GameContext): string {
  const st = editorState(ctx)
  const before = npcSnapshot(ctx)
  const problems = readOverride(ctx.data, st, 'npcs')
  applyLayers(ctx.data, st)
  const changed = applyNpcDiff(ctx, before)
  broadcastContent(ctx, 'npcs', st.npcs.rev)
  return `npcs rev ${st.npcs.rev}: ${changed} changed${problems.length ? `, ${problems.length} problems (first: ${problems[0]})` : ''}`
}

export function runContentCommand(g: GmCall): GmResult {
  const refused = editorRefusal(g)
  if (refused) return refused
  const { ctx, args } = g
  const sub = (args[0] ?? 'status').toLowerCase()
  const st = editorState(ctx)
  if (sub === 'status' && args.length <= 1) {
    const n = st.nests
    const c = st.npcs
    const quests = listQuestOverrides(st.root)
    const lines = [
      `Content overrides in ${st.root}:`,
      `nests rev ${n.rev}: ${n.add.length} authored, ${n.patch.length} patched, ${n.remove.length} removed; ${listHistory(st.root, NESTS_OVERRIDE_FILE).length} history copies${st.problems.nests.length ? `; ${st.problems.nests.length} problems (first: ${st.problems.nests[0]})` : ''}`,
      `npcs rev ${c.rev}: ${c.add.length} authored, ${c.patch.length} patched (${c.patch.filter((p) => p.hidden).length} hidden); ${listHistory(st.root, NPCS_OVERRIDE_FILE).length} history copies${st.problems.npcs.length ? `; ${st.problems.npcs.length} problems (first: ${st.problems.npcs[0]})` : ''}`,
      `quests: ${quests.length} override file${quests.length === 1 ? '' : 's'}${quests.length ? ` (${quests.slice(0, 20).join(', ')}${quests.length > 20 ? ', ...' : ''})` : ''}`,
    ]
    return ok(lines.join('\n'), { nests: { rev: n.rev, add: n.add.length, patch: n.patch.length, remove: n.remove.length }, npcs: { rev: c.rev, add: c.add.length, patch: c.patch.length }, quests })
  }
  if (sub === 'reload' && args.length <= 2) {
    const what = (args[1] ?? 'all').toLowerCase()
    if (!['nests', 'npcs', 'quests', 'all'].includes(what)) return fail(`Usage: ${CONTENT_USAGE}`)
    const done: string[] = []
    if (what === 'nests' || what === 'all') done.push(reloadNests(ctx))
    if (what === 'npcs' || what === 'all') done.push(reloadNpcs(ctx))
    if (what === 'quests' || what === 'all') done.push(`quests catalog rev ${reloadQuests(ctx)}`)
    return ok(`Reloaded: ${done.join('; ')}.`, { reloaded: what })
  }
  return fail(`Usage: ${CONTENT_USAGE}`)
}

/** Quest ids with an override file in DATA_DIR/content/quests. */
export function listQuestOverrides(root: string): string[] {
  try {
    return readdirSync(join(root, QUEST_OVERRIDE_DIR))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .sort()
  } catch {
    return []
  }
}
