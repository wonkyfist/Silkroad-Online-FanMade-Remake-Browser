import { CODE_NAME, type GmNestInfo, type NestDef, type TacticsDef } from '@sro/shared'
import type { GameContext } from '../game.ts'
import type { GmCall, GmResult } from '../gm.ts'
import { commitNests, draftNests, editorRefusal, editorState, fail, fmt, ok, round1 } from './live.ts'
import {
  AUTHORED_NEST_ID_MIN,
  authoredMobTotal,
  authoredNestDef,
  checkAuthoredNest,
  checkNestPatch,
  NEST_AUTHORED_MOBS_MAX,
  NEST_COUNT_MAX,
  NEST_RADIUS_MAX,
  NEST_RADIUS_MIN,
  NEST_RESPAWN_MAX_SEC,
  NESTS_OVERRIDE_FILE,
  nestSource,
  OVERRIDE_RECORDS_MAX,
  overrideRefs,
  parseNestOverride,
  patchedNestDef,
  popHistory,
  type AuthoredNest,
  type NestOverrideFile,
  type NestPatch,
} from './overrides.ts'

/**
 * The spawn editor's `nest` GM command (docs/QUESTS.md §5.2; lane ED-S). Registered as `COMMANDS.nest` in gm.ts, so it
 * has the same role check, audit row, budget and slash form as every GM command, plus the EDITOR_ROLE gate. Every write
 * updates DATA_DIR/content/nests.override.json (history copy + atomic write) and the live spawner at once.
 */
export const NEST_USAGE =
  'nest near [radius] | add <mob> [count] [radius] [respawnSec] | move <id> | set <id> <field> <value> | remove <id> | restore <id> | undo'

export const NEST_NEAR_DEFAULT = 150
export const NEST_NEAR_MAX = 1000
/** Most nests one `nest near` lists (the nearest first). */
export const NEST_NEAR_LIST_MAX = 40
const ADD_DEFAULTS = { count: 5, radius: 30, respawnSec: 30 }
/** Tactics of an authored nest whose mob has no retail nest (docs/QUESTS.md §5.2): passive, sight 10 m, leash 50 m. */
const DEFAULT_TACTICS: TacticsDef = { id: 0, aggressive: false, sightRange: 10, leashRange: 50 }
const SET_FIELDS = ['mob', 'count', 'radius', 'spawnradius', 'respawn', 'aggressive', 'champion', 'enabled'] as const

function num(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const v = Number(raw)
  return Number.isFinite(v) ? v : null
}

function intArg(raw: string | undefined, lo: number, hi: number): number | null {
  const v = num(raw)
  return v !== null && Number.isInteger(v) && v >= lo && v <= hi ? v : null
}

function nestId(raw: string | undefined): number | null {
  if (raw === undefined || !/^#?\d{1,16}$/.test(raw)) return null
  const v = Number(raw.replace('#', ''))
  return Number.isSafeInteger(v) ? v : null
}

function onOff(raw: string | undefined): boolean | null {
  const a = (raw ?? '').toLowerCase()
  if (['on', 'yes', 'true', '1'].includes(a)) return true
  if (['off', 'no', 'false', '0'].includes(a)) return false
  return null
}

/** "30" -> [30, 30], "20-40" -> [20, 40] (seconds, 1..86400). */
function respawnArg(raw: string | undefined): [number, number] | null {
  if (raw === undefined) return null
  const m = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(raw.trim())
  if (!m) return null
  const lo = Number(m[1])
  const hi = m[2] === undefined ? lo : Number(m[2])
  return lo >= 1 && hi <= NEST_RESPAWN_MAX_SEC && lo <= hi ? [lo, hi] : null
}

/** The GM-facing view of a nest (docs/QUESTS.md §5.2 `GmNestInfo`). */
export function nestInfo(ctx: GameContext, def: NestDef, o: NestOverrideFile = editorState(ctx).nests): GmNestInfo {
  const mob = ctx.data.mob(def.mob)
  const live = ctx.gameplay.spawner.nest(def.id)
  return {
    id: def.id,
    mob: def.mob,
    mobName: mob?.name ?? def.mob,
    level: mob?.level ?? def.level ?? 0,
    x: round1(def.x),
    z: round1(def.z),
    radius: def.radius,
    spawnRadius: def.spawnRadius,
    count: def.count,
    alive: live ? live.alive.size : 0,
    respawnSec: [def.respawnSec[0], def.respawnSec[1]],
    aggressive: def.tactics.aggressive,
    enabled: def.enabled !== false,
    source: nestSource(def.id, o),
  }
}

export function describeNest(i: GmNestInfo): string {
  const flags = [i.source, i.enabled ? '' : 'disabled', i.aggressive ? 'aggressive' : ''].filter(Boolean).join(', ')
  const respawn = i.respawnSec[0] === i.respawnSec[1] ? `${i.respawnSec[0]}s` : `${i.respawnSec[0]}-${i.respawnSec[1]}s`
  return `#${i.id} ${i.mobName} (${i.mob}, Lv ${i.level}) x${i.count} (${i.alive} alive) r${i.radius}/${i.spawnRadius} respawn ${respawn} at ${fmt(i.x)}, ${fmt(i.z)} [${flags}]`
}

/** The effective nest `id` (after the overrides), if it exists in this world. */
function effective(ctx: GameContext, id: number): NestDef | undefined {
  return ctx.data.nests.find((n) => n.id === id && n.world === ctx.config.world)
}

/** Why the live spawner would refuse `def` (a nest that exists but stays empty), as a GM message; null when it spawns. */
function spawnProblem(ctx: GameContext, def: NestDef): string | null {
  const r = ctx.gameplay.spawner.refusal(def)
  if (r === null || r === 'disabled') return null
  if (r === 'outside the world') return 'That spot is not on open ground (no walkable navmesh near the nest centre).'
  if (r.startsWith('level ')) return `That monster is too strong for this server (${r}; MOB_LEVEL_MAX).`
  return `The nest would not spawn: ${r}.`
}

/** The next free authored id (never below AUTHORED_NEST_ID_MIN). */
function nextAuthoredId(o: NestOverrideFile): number {
  return Math.max(AUTHORED_NEST_ID_MIN - 1, ...o.add.map((n) => n.id)) + 1
}

/** Retail tactics of the mob's first exported nest, else passive (sight 10 m, leash 50 m). */
function tacticsFor(ctx: GameContext, mob: string): TacticsDef {
  const st = editorState(ctx)
  const retail = st.base.nests.find((n) => n.mob === mob)
  return retail ? { id: retail.tactics.id, aggressive: retail.tactics.aggressive, sightRange: retail.tactics.sightRange, leashRange: retail.tactics.leashRange } : { ...DEFAULT_TACTICS }
}

/**
 * Applies `edit` to nest `id` in a draft of the override: an authored nest is changed in `add`, an exported one gets
 * (or extends) its `patch`. Returns the draft, or a failure.
 */
function editNest(ctx: GameContext, id: number, edit: { authored: (a: AuthoredNest) => void; patch: (p: NestPatch) => void }): NestOverrideFile | GmResult {
  const draft = draftNests(editorState(ctx))
  if (id >= AUTHORED_NEST_ID_MIN) {
    const a = draft.add.find((n) => n.id === id)
    if (!a) return fail(`No authored nest #${id}.`)
    edit.authored(a)
    const r = checkAuthoredNest(a, { mob: (c) => ctx.data.mob(c) })
    if ('problems' in r) return fail(`Invalid nest: ${r.problems.join('; ')}`)
    return draft
  }
  if (!editorState(ctx).base.nests.some((n) => n.id === id && n.world === ctx.config.world)) return fail(`No nest #${id}.`)
  if (draft.remove.includes(id)) return fail(`Nest #${id} was removed; "nest restore ${id}" brings it back.`)
  let p = draft.patch.find((x) => x.id === id)
  if (!p) draft.patch.push((p = { id }))
  edit.patch(p)
  const r = checkNestPatch(p, overrideRefs(ctx.data, editorState(ctx)))
  if ('problems' in r) return fail(`Invalid change: ${r.problems.join('; ')}`)
  return draft
}

/** The nest `id` as it would be under `draft` (for the pre-write spawn check). */
function preview(ctx: GameContext, draft: NestOverrideFile, id: number): NestDef | undefined {
  const st = editorState(ctx)
  const refs = overrideRefs(ctx.data, st)
  const { file } = parseNestOverride(draft, refs)
  const a = file.add.find((n) => n.id === id)
  if (a) return authoredNestDef(a, ctx.data.mob(a.mob))
  const base = st.base.nests.find((n) => n.id === id)
  if (!base || file.remove.includes(id)) return undefined
  const p = file.patch.find((x) => x.id === id)
  return p ? patchedNestDef(base, p, p.mob ? ctx.data.mob(p.mob) : undefined) : base
}

/** Commits `draft` after checking nest `id` would still spawn and the authored total stays capped; replies with the nest. */
function commitEdit(ctx: GameContext, draft: NestOverrideFile, id: number, verb: string): GmResult {
  const total = authoredMobTotal(draft)
  const before = authoredMobTotal(editorState(ctx).nests)
  if (total > NEST_AUTHORED_MOBS_MAX && total > before) {
    return fail(`Too many authored monsters: this change makes ${total}, the limit is ${NEST_AUTHORED_MOBS_MAX} (now ${before}). Lower some counts or remove nests first.`)
  }
  const next = preview(ctx, draft, id)
  if (!next) return fail(`No nest #${id}.`)
  const problem = spawnProblem(ctx, next)
  if (problem) return fail(problem)
  commitNests(ctx, draft)
  const def = effective(ctx, id)
  if (!def) return fail(`Nest #${id} is gone after the change.`)
  const info = nestInfo(ctx, def)
  const town = ctx.data.inSafeArea(ctx.config.world, def.x, def.z) ? '\nNote: the centre is inside a town safe area, where players cannot fight.' : ''
  return ok(`${verb}: ${describeNest(info)}${ctx.config.spawnMobs ? '' : ' (monster spawning is off on this server)'}${town}`, { nest: info })
}

function near(g: GmCall): GmResult {
  const { ctx, args, self } = g
  if (!self) return fail('nest near needs your character in the world.')
  const radius = args[1] === undefined ? NEST_NEAR_DEFAULT : num(args[1])
  if (radius === null || radius <= 0 || radius > NEST_NEAR_MAX || args.length > 2) return fail(`Usage: nest near [1-${NEST_NEAR_MAX}]`)
  const at = ctx.world.positionAt(self, Date.now())
  const found = ctx.data.nests
    .filter((n) => n.world === ctx.config.world)
    .map((n) => ({ n, d: Math.hypot(n.x - at[0], n.z - at[2]) }))
    .filter((x) => x.d <= radius)
    .sort((a, b) => a.d - b.d)
  const st = editorState(ctx)
  const nests = found.slice(0, NEST_NEAR_LIST_MAX).map((x) => nestInfo(ctx, x.n, st.nests))
  const head = `${found.length} nest${found.length === 1 ? '' : 's'} within ${radius} m${found.length > nests.length ? ` (the nearest ${nests.length} listed)` : ''}`
  return ok([head, ...nests.map(describeNest)].join('\n'), { nests })
}

function add(g: GmCall): GmResult {
  const { ctx, conn, args, self } = g
  if (!self) return fail('nest add needs your character in the world.')
  const usage = `Usage: nest add <mob code> [count 1-${NEST_COUNT_MAX}] [radius ${NEST_RADIUS_MIN}-${NEST_RADIUS_MAX}] [respawn seconds or min-max]`
  if (args.length < 2 || args.length > 5) return fail(usage)
  const code = args[1].trim().toUpperCase()
  if (!CODE_NAME.test(code)) return fail(usage)
  const mob = ctx.data.mob(code)
  if (!mob) return fail(`No monster ${code}.`)
  const count = args[2] === undefined ? ADD_DEFAULTS.count : intArg(args[2], 1, NEST_COUNT_MAX)
  const radius = args[3] === undefined ? ADD_DEFAULTS.radius : num(args[3])
  const respawn = args[4] === undefined ? ([ADD_DEFAULTS.respawnSec, ADD_DEFAULTS.respawnSec] as [number, number]) : respawnArg(args[4])
  if (count === null || radius === null || radius < NEST_RADIUS_MIN || radius > NEST_RADIUS_MAX || respawn === null) return fail(usage)
  return addNestAt(ctx, conn.account, ctx.world.livePoint(self, Date.now()), code, count, radius, respawn)
}

/**
 * `nest add` at an explicit point (the GM's position, or coordinates typed in the admin panel, docs/ADMIN.md): checks
 * the mob, the authored caps and that the nest spawns, then commits it. `by` is the account written as its author.
 */
export function addNestAt(ctx: GameContext, by: string, at: { x: number; y: number; z: number }, code: string, count: number, radius: number, respawn: [number, number]): GmResult {
  if (!ctx.data.mob(code)) return fail(`No monster ${code}.`)
  const draft = draftNests(editorState(ctx))
  if (draft.add.length >= OVERRIDE_RECORDS_MAX) return fail(`Too many authored nests (${OVERRIDE_RECORDS_MAX}); remove some first.`)
  const id = nextAuthoredId(draft)
  const nest: AuthoredNest = {
    id,
    mob: code,
    x: round2(at.x),
    z: round2(at.z),
    y: round2(at.y),
    radius,
    spawnRadius: radius,
    count,
    respawnSec: respawn,
    tactics: tacticsFor(ctx, code),
    world: ctx.config.world,
    provenance: 'authored',
    source: { file: NESTS_OVERRIDE_FILE, by, at: new Date().toISOString() },
  }
  const checked = checkAuthoredNest(nest, { mob: (c) => ctx.data.mob(c) })
  if ('problems' in checked) return fail(`Invalid nest: ${checked.problems.join('; ')}`)
  draft.add.push(checked.nest)
  return commitEdit(ctx, draft, id, 'Added nest')
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function move(g: GmCall): GmResult {
  const { ctx, args, self } = g
  if (!self) return fail('nest move needs your character in the world.')
  const id = nestId(args[1])
  if (id === null || args.length !== 2) return fail('Usage: nest move <id>')
  return moveNestTo(ctx, id, ctx.world.livePoint(self, Date.now()))
}

/** `nest move` to an explicit point (the GM's position or admin panel coordinates). */
export function moveNestTo(ctx: GameContext, id: number, at: { x: number; y: number; z: number }): GmResult {
  const pos = { x: round2(at.x), z: round2(at.z), y: round2(at.y) }
  const draft = editNest(ctx, id, { authored: (a) => Object.assign(a, pos), patch: (p) => Object.assign(p, pos) })
  if ('ok' in draft) return draft
  return commitEdit(ctx, draft, id, 'Moved nest')
}

function set(g: Pick<GmCall, 'ctx' | 'args'>): GmResult {
  const { ctx, args } = g
  const usage = `Usage: nest set <id> <${SET_FIELDS.join('|')}> <value>`
  const id = nestId(args[1])
  const field = (args[2] ?? '').toLowerCase() as (typeof SET_FIELDS)[number]
  const raw = args[3]
  if (id === null || !SET_FIELDS.includes(field) || raw === undefined || args.length !== 4) return fail(usage)
  let change: Partial<NestPatch>
  switch (field) {
    case 'mob': {
      const code = raw.trim().toUpperCase()
      if (!CODE_NAME.test(code) || !ctx.data.mob(code)) return fail(`No monster ${code}.`)
      change = { mob: code }
      break
    }
    case 'count': {
      const v = intArg(raw, 1, NEST_COUNT_MAX)
      if (v === null) return fail(`count: a whole number from 1 to ${NEST_COUNT_MAX}.`)
      change = { count: v }
      break
    }
    case 'radius': {
      const v = num(raw)
      if (v === null || v < NEST_RADIUS_MIN || v > NEST_RADIUS_MAX) return fail(`radius: ${NEST_RADIUS_MIN} to ${NEST_RADIUS_MAX} metres.`)
      change = { radius: v }
      break
    }
    case 'spawnradius': {
      const v = num(raw)
      if (v === null || v < 0 || v > NEST_RADIUS_MAX) return fail(`spawnradius: 0 to ${NEST_RADIUS_MAX} metres.`)
      change = { spawnRadius: v }
      break
    }
    case 'respawn': {
      const v = respawnArg(raw)
      if (v === null) return fail(`respawn: seconds (1-${NEST_RESPAWN_MAX_SEC}) or min-max, e.g. 20-40.`)
      change = { respawnSec: v }
      break
    }
    case 'aggressive':
    case 'enabled': {
      const v = onOff(raw)
      if (v === null) return fail(`${field}: on or off.`)
      change = field === 'aggressive' ? { aggressive: v } : { enabled: v }
      break
    }
    case 'champion': {
      const v = num(raw)
      if (v === null || v < 0 || v > 100) return fail('champion: a percentage from 0 to 100.')
      change = { championPct: v }
      break
    }
  }
  const draft = editNest(ctx, id, {
    authored: (a) => {
      const { aggressive, ...rest } = change
      Object.assign(a, rest)
      // A new mob brings its own retail tactics, like `nest add`.
      if (change.mob !== undefined) a.tactics = tacticsFor(ctx, change.mob)
      if (aggressive !== undefined) a.tactics = { ...a.tactics, aggressive }
    },
    patch: (p) => Object.assign(p, change),
  })
  if ('ok' in draft) return draft
  return commitEdit(ctx, draft, id, 'Changed nest')
}

function remove(g: Pick<GmCall, 'ctx' | 'args'>): GmResult {
  const { ctx, args } = g
  const id = nestId(args[1])
  if (id === null || args.length !== 2) return fail('Usage: nest remove <id>')
  const draft = draftNests(editorState(ctx))
  const def = effective(ctx, id)
  if (!def) return fail(`No nest #${id}.`)
  if (id >= AUTHORED_NEST_ID_MIN) draft.add = draft.add.filter((n) => n.id !== id)
  else {
    draft.patch = draft.patch.filter((p) => p.id !== id)
    if (!draft.remove.includes(id)) draft.remove.push(id)
  }
  const info = nestInfo(ctx, def)
  commitNests(ctx, draft)
  return ok(`Removed nest #${id} (${info.mobName} x${info.count}${id >= AUTHORED_NEST_ID_MIN ? ', deleted' : ', exported: hidden by the override'}).`, { id })
}

function restore(g: Pick<GmCall, 'ctx' | 'args'>): GmResult {
  const { ctx, args } = g
  const id = nestId(args[1])
  if (id === null || args.length !== 2) return fail('Usage: nest restore <id>')
  if (id >= AUTHORED_NEST_ID_MIN) return fail('Only exported nests can be restored (authored nests: "nest undo").')
  const st = editorState(ctx)
  if (!st.nests.remove.includes(id) && !st.nests.patch.some((p) => p.id === id)) return fail(`Nest #${id} has no override.`)
  const draft = draftNests(st)
  draft.remove = draft.remove.filter((x) => x !== id)
  draft.patch = draft.patch.filter((p) => p.id !== id)
  commitNests(ctx, draft)
  const def = effective(ctx, id)
  if (!def) return ok(`Nest #${id} is back to its exported state (not in this world).`, { id })
  const info = nestInfo(ctx, def)
  return ok(`Restored the exported nest: ${describeNest(info)}`, { nest: info })
}

function undo(g: Pick<GmCall, 'ctx' | 'args'>): GmResult {
  const { ctx, args } = g
  if (args.length !== 1) return fail('Usage: nest undo')
  const st = editorState(ctx)
  const raw = popHistory(st.root, NESTS_OVERRIDE_FILE)
  if (raw === null) return fail('Nothing to undo.')
  const { file, problems } = parseNestOverride(raw, overrideRefs(ctx.data, st))
  const next = commitNests(ctx, file, { undo: true })
  return ok(`Undone: the spawn overrides are back to their previous version (now rev ${next.rev}; ${next.add.length} authored, ${next.patch.length} patched, ${next.remove.length} removed)${problems.length ? `; skipped ${problems.length} invalid records` : ''}.`, {
    rev: next.rev,
  })
}

export function runNestCommand(g: GmCall): GmResult {
  const refused = editorRefusal(g)
  if (refused) return refused
  switch ((g.args[0] ?? '').toLowerCase()) {
    case 'near':
      return near(g)
    case 'add':
      return add(g)
    case 'move':
      return move(g)
    case 'set':
      return set(g)
    case 'remove':
      return remove(g)
    case 'restore':
      return restore(g)
    case 'undo':
      return undo(g)
    default:
      return fail(`Usage: ${NEST_USAGE}`)
  }
}

/**
 * The nest edits that need no position, for callers without a GM character (the admin panel, docs/ADMIN.md): the same
 * argument lists as the `nest` command (`['set', id, field, value]`, `['remove', id]`, `['restore', id]`, `['undo']`).
 */
export const nestEdits = { set, remove, restore, undo } as const
