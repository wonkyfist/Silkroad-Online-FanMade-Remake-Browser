import { AUTHORED_NPC_CODE, CODE_NAME, type GmNpcInfo, type NpcDef } from '@sro/shared'
import type { GameContext } from '../game.ts'
import type { GmCall, GmResult } from '../gm.ts'
import { commitNpcs, draftNpcs, editorRefusal, editorState, fail, fmt, ok, round1 } from './live.ts'
import {
  checkAuthoredNpc,
  checkNpcPatch,
  cleanNpcName,
  NPC_NAME_MAX,
  NPCS_OVERRIDE_FILE,
  npcSource,
  OVERRIDE_RECORDS_MAX,
  overrideRefs,
  parseNpcOverride,
  popHistory,
  type AuthoredNpc,
  type NpcOverrideFile,
  type NpcPatch,
} from './overrides.ts'
import { questsUsingNpc } from './quest-api.ts'

/**
 * The NPC editor's `npc` GM command (docs/QUESTS.md §5.3; lane ED-S), registered as `COMMANDS.npc` in gm.ts. Every write
 * updates DATA_DIR/content/npcs.override.json and the live world: a changed NPC is re-placed (despawn + spawn through
 * interest management). Authored NPCs are `NPCX_<n>` wearing a base NPC's model (`Npc.model`; World's `npcTag` then
 * sends `model: base` and `npc: code`, decision 43).
 */
export const NPC_USAGE =
  'npc near [radius] | add <base code> <name...> | move <code> | face <code> | rename <code> <name...> | shop <code> <shop|none> | remove <code> | restore <code> | undo'

export const NPC_NEAR_DEFAULT = 60
export const NPC_NEAR_MAX = 1000
export const NPC_NEAR_LIST_MAX = 40

function codeArg(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const c = raw.trim().toUpperCase()
  return CODE_NAME.test(c) ? c : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Every NPC the editor knows in this world: the exported ones (patched, hidden ones included) and the authored ones. */
function allNpcs(ctx: GameContext): { def: NpcDef; base: string; hidden: boolean }[] {
  const st = editorState(ctx)
  const patches = new Map(st.npcs.patch.map((p) => [p.code, p]))
  const live = new Map(ctx.data.npcs.map((n) => [n.code, n]))
  const out: { def: NpcDef; base: string; hidden: boolean }[] = []
  for (const n of st.base.npcs) {
    if (n.world !== ctx.config.world) continue
    const hidden = patches.get(n.code)?.hidden === true
    out.push({ def: hidden ? n : (live.get(n.code) ?? n), base: n.code, hidden })
  }
  for (const a of st.npcs.add) {
    const def = live.get(a.code)
    if (def) out.push({ def, base: a.base, hidden: false })
  }
  return out
}

/** The GM-facing view of an NPC (docs/QUESTS.md §5.3 `GmNpcInfo`). */
export function npcInfo(ctx: GameContext, def: NpcDef, base: string, hidden: boolean, o: NpcOverrideFile = editorState(ctx).npcs): GmNpcInfo {
  let entity: number | null = null
  for (const e of ctx.world.npcs.values()) {
    if (e.code === def.code) {
      entity = e.id
      break
    }
  }
  const shop = ctx.data.npcShop.get(def.code)
  return {
    code: def.code,
    base,
    name: def.name ?? def.code,
    x: round1(def.x),
    z: round1(def.z),
    yaw: round3(def.yaw ?? 0),
    entity,
    ...(shop ? { shop } : {}),
    ...(hidden ? { hidden: true } : {}),
    source: npcSource(def.code, o),
  }
}

export function describeNpc(i: GmNpcInfo): string {
  const flags = [i.source, i.hidden ? 'hidden' : '', i.entity === null && !i.hidden ? 'not placed' : ''].filter(Boolean).join(', ')
  const look = i.base !== i.code ? ` looks like ${i.base}` : ''
  return `${i.code} "${i.name}"${look} at ${fmt(i.x)}, ${fmt(i.z)}${i.shop ? ` shop ${i.shop}` : ''} [${flags}]`
}

function find(ctx: GameContext, code: string): { def: NpcDef; base: string; hidden: boolean } | undefined {
  return allNpcs(ctx).find((n) => n.def.code === code)
}

/** Applies `edit` to NPC `code` in a draft: authored NPCs change in `add`, exported ones get (or extend) their `patch`. */
function editNpc(ctx: GameContext, code: string, edit: { authored: (a: AuthoredNpc) => void; patch: (p: NpcPatch) => void }): NpcOverrideFile | GmResult {
  const st = editorState(ctx)
  const draft = draftNpcs(st)
  const refs = overrideRefs(ctx.data, st)
  if (AUTHORED_NPC_CODE.test(code)) {
    const a = draft.add.find((n) => n.code === code)
    if (!a) return fail(`No authored NPC ${code}.`)
    edit.authored(a)
    const r = checkAuthoredNpc(a, refs)
    return 'problems' in r ? fail(`Invalid NPC: ${r.problems.join('; ')}`) : draft
  }
  if (!st.base.npcs.some((n) => n.code === code && n.world === ctx.config.world)) return fail(`No NPC ${code}.`)
  let p = draft.patch.find((x) => x.code === code)
  if (p?.hidden) return fail(`${code} is removed; "npc restore ${code}" brings it back.`)
  if (!p) draft.patch.push((p = { code }))
  edit.patch(p)
  const r = checkNpcPatch(p, refs)
  return 'problems' in r ? fail(`Invalid change: ${r.problems.join('; ')}`) : draft
}

function reply(ctx: GameContext, code: string, verb: string, extra = ''): GmResult {
  const n = find(ctx, code)
  if (!n) return ok(`${verb} ${code}.${extra}`, { code })
  const info = npcInfo(ctx, n.def, n.base, n.hidden)
  const unplaced = info.entity === null && !info.hidden ? ' (no walkable ground there: it is saved but not placed)' : ''
  return ok(`${verb}: ${describeNpc(info)}${unplaced}${extra}`, { npc: info })
}

/** A quest-use warning for removals and moves (docs/QUESTS.md §5.3). */
function questWarning(ctx: GameContext, code: string): string {
  const used = questsUsingNpc(ctx, code)
  return used.length ? `\nWarning: quests use ${code}: ${used.slice(0, 10).join(', ')}${used.length > 10 ? ', ...' : ''}. They cannot be taken or turned in until it is back.` : ''
}

function near(g: GmCall): GmResult {
  const { ctx, args, self } = g
  if (!self) return fail('npc near needs your character in the world.')
  const radius = args[1] === undefined ? NPC_NEAR_DEFAULT : Number(args[1])
  if (!Number.isFinite(radius) || radius <= 0 || radius > NPC_NEAR_MAX || args.length > 2) return fail(`Usage: npc near [1-${NPC_NEAR_MAX}]`)
  const at = ctx.world.positionAt(self, Date.now())
  const found = allNpcs(ctx)
    .map((n) => ({ n, d: Math.hypot(n.def.x - at[0], n.def.z - at[2]) }))
    .filter((x) => x.d <= radius)
    .sort((a, b) => a.d - b.d)
  const st = editorState(ctx)
  const npcs = found.slice(0, NPC_NEAR_LIST_MAX).map((x) => npcInfo(ctx, x.n.def, x.n.base, x.n.hidden, st.npcs))
  const head = `${found.length} NPC${found.length === 1 ? '' : 's'} within ${radius} m${found.length > npcs.length ? ` (the nearest ${npcs.length} listed)` : ''}`
  return ok([head, ...npcs.map(describeNpc)].join('\n'), { npcs })
}

function add(g: GmCall): GmResult {
  const { ctx, args, self } = g
  if (!self) return fail('npc add needs your character in the world.')
  const usage = 'Usage: npc add <base NPC code> <name...>'
  const base = codeArg(args[1])
  if (!base || args.length < 3) return fail(usage)
  const st = editorState(ctx)
  if (!st.base.npcs.some((n) => n.code === base)) return fail(`No NPC ${base} in npcs.json to copy the look from.`)
  const name = cleanNpcName(args.slice(2).join(' '))
  if (name === null) return fail(`The name must be 1-${NPC_NAME_MAX} characters.`)
  const draft = draftNpcs(st)
  if (draft.add.length >= OVERRIDE_RECORDS_MAX) return fail(`Too many authored NPCs (${OVERRIDE_RECORDS_MAX}); remove some first.`)
  const code = `NPCX_${nextNumber(draft)}`
  const now = Date.now()
  ctx.world.settle(self, now)
  const at = ctx.world.livePoint(self, now)
  const npc: AuthoredNpc = { code, base, name, x: round2(at.x), z: round2(at.z), y: round2(at.y), yaw: round3(self.yaw) }
  const r = checkAuthoredNpc(npc, overrideRefs(ctx.data, st))
  if ('problems' in r) return fail(`Invalid NPC: ${r.problems.join('; ')}`)
  draft.add.push(r.npc)
  commitNpcs(ctx, draft)
  return reply(ctx, code, 'Added NPC')
}

/** Authored codes are NPCX_<n>: the next n after every one in use (and every one handed out by this process). */
let highWater = 0
function nextNumber(o: NpcOverrideFile): number {
  for (const a of o.add) {
    const m = /^NPCX_(\d{1,9})$/.exec(a.code)
    if (m) highWater = Math.max(highWater, Number(m[1]))
  }
  return ++highWater
}

function place(g: GmCall, what: 'move' | 'face'): GmResult {
  const { ctx, args, self } = g
  if (!self) return fail(`npc ${what} needs your character in the world.`)
  const code = codeArg(args[1])
  if (!code || args.length !== 2) return fail(`Usage: npc ${what} <code>`)
  const now = Date.now()
  ctx.world.settle(self, now)
  const at = ctx.world.livePoint(self, now)
  const change = what === 'move' ? { x: round2(at.x), z: round2(at.z), y: round2(at.y) } : { yaw: round3(self.yaw) }
  const draft = editNpc(ctx, code, { authored: (a) => Object.assign(a, change), patch: (p) => Object.assign(p, change) })
  if ('ok' in draft) return draft
  commitNpcs(ctx, draft)
  return reply(ctx, code, what === 'move' ? 'Moved NPC' : 'Turned NPC')
}

function rename(g: GmCall): GmResult {
  const { ctx, args } = g
  const code = codeArg(args[1])
  if (!code || args.length < 3) return fail('Usage: npc rename <code> <name...>')
  const name = cleanNpcName(args.slice(2).join(' '))
  if (name === null) return fail(`The name must be 1-${NPC_NAME_MAX} characters.`)
  const draft = editNpc(ctx, code, { authored: (a) => (a.name = name), patch: (p) => (p.name = name) })
  if ('ok' in draft) return draft
  commitNpcs(ctx, draft)
  return reply(ctx, code, 'Renamed NPC')
}

function shop(g: GmCall): GmResult {
  const { ctx, args } = g
  const code = codeArg(args[1])
  const raw = (args[2] ?? '').trim()
  if (!code || !raw || args.length !== 3) return fail('Usage: npc shop <code> <shop id|none>')
  const none = raw.toLowerCase() === 'none'
  const id = none ? null : [...ctx.data.shops.keys()].find((s) => s.toUpperCase() === raw.toUpperCase())
  if (!none && !id) return fail(`No shop ${raw} in shops.json.`)
  const draft = editNpc(ctx, code, {
    authored: (a) => {
      if (id) a.shop = id
      else delete a.shop
    },
    patch: (p) => (p.shop = id ?? null),
  })
  if ('ok' in draft) return draft
  commitNpcs(ctx, draft)
  return reply(ctx, code, id ? `Shop ${id} attached to NPC` : 'Shop removed from NPC')
}

function remove(g: GmCall): GmResult {
  const { ctx, args } = g
  const code = codeArg(args[1])
  if (!code || args.length !== 2) return fail('Usage: npc remove <code>')
  const st = editorState(ctx)
  const draft = draftNpcs(st)
  if (AUTHORED_NPC_CODE.test(code)) {
    if (!draft.add.some((a) => a.code === code)) return fail(`No authored NPC ${code}.`)
    draft.add = draft.add.filter((a) => a.code !== code)
  } else {
    if (!st.base.npcs.some((n) => n.code === code && n.world === ctx.config.world)) return fail(`No NPC ${code}.`)
    const p = draft.patch.find((x) => x.code === code)
    if (p?.hidden) return fail(`${code} is already removed.`)
    if (p) p.hidden = true
    else draft.patch.push({ code, hidden: true })
  }
  commitNpcs(ctx, draft)
  return ok(`Removed NPC ${code}${AUTHORED_NPC_CODE.test(code) ? ' (deleted)' : ' (exported: hidden by the override; "npc restore" brings it back)'}.${questWarning(ctx, code)}`, { code })
}

function restore(g: GmCall): GmResult {
  const { ctx, args } = g
  const code = codeArg(args[1])
  if (!code || args.length !== 2) return fail('Usage: npc restore <code>')
  if (AUTHORED_NPC_CODE.test(code)) return fail('Only exported NPCs can be restored (authored NPCs: "npc undo").')
  const st = editorState(ctx)
  if (!st.npcs.patch.some((p) => p.code === code)) return fail(`${code} has no override.`)
  const draft = draftNpcs(st)
  draft.patch = draft.patch.filter((p) => p.code !== code)
  commitNpcs(ctx, draft)
  return reply(ctx, code, 'Restored the exported NPC')
}

function undo(g: GmCall): GmResult {
  const { ctx, args } = g
  if (args.length !== 1) return fail('Usage: npc undo')
  const st = editorState(ctx)
  const raw = popHistory(st.root, NPCS_OVERRIDE_FILE)
  if (raw === null) return fail('Nothing to undo.')
  const { file, problems } = parseNpcOverride(raw, overrideRefs(ctx.data, st))
  const next = commitNpcs(ctx, file, { undo: true })
  return ok(`Undone: the NPC overrides are back to their previous version (now rev ${next.rev}; ${next.add.length} authored, ${next.patch.length} patched)${problems.length ? `; skipped ${problems.length} invalid records` : ''}.`, {
    rev: next.rev,
  })
}

export function runNpcCommand(g: GmCall): GmResult {
  const refused = editorRefusal(g)
  if (refused) return refused
  switch ((g.args[0] ?? '').toLowerCase()) {
    case 'near':
      return near(g)
    case 'add':
      return add(g)
    case 'move':
      return place(g, 'move')
    case 'face':
      return place(g, 'face')
    case 'rename':
      return rename(g)
    case 'shop':
      return shop(g)
    case 'remove':
      return remove(g)
    case 'restore':
      return restore(g)
    case 'undo':
      return undo(g)
    default:
      return fail(`Usage: ${NPC_USAGE}`)
  }
}
