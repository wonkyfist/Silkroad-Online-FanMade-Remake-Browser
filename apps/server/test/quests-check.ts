/**
 * Content checker for the authored questlines (docs/QUESTS.md §1.2, §3; docs/WAVE_PLAN.md §5.3 CT).
 *   pnpm tsx apps/server/test/quests-check.ts [content/quests/jangan.json] [--world jangan-fields]
 * Exit code 1 when there is an error. apps/server/test/quests-content-check.test.ts runs checkQuestContent().
 *
 * What it checks, on top of the shared validator (validateQuestFile with refs: types, bounds, ids, references):
 * - codes: every NPC is a placed NPC of the file's world; mobs, items, reward token expansions and iconItem exist;
 * - levels: quest mobs are at most 3 levels above the quest (unique encounter mobs excepted; a daily's mobs stay inside
 *   its level window); reward items have reqLevel <= quest level + 2; prerequisites are not above the quest's level;
 * - EXP (QUESTS §3.4): SP = max(1, round(exp / 600)); the non-repeatable quests of each level 1-19 give >= 30 % of
 *   levels[L].exp (25-40 % from level 8 on), 20-35 % of the whole 1 -> 20 climb; dailies give 1-6 % of the level;
 * - the navmesh of the play export (jangan-fields, the one the server loads): every LOC_* passes nav.locate, lies in the
 *   town spawn's walkable component (MeshNav home) and is open ground at its centre (nav.place); every NPC the file
 *   uses is placed by the server's rule and has home ground within the NPC walk range (3 m); every objective mob has a
 *   nest the spawner accepts (the server's rule: level <= MOB_LEVEL_MAX, open home ground near the centre, which
 *   drops the ~91 unreachable north-west nests) within 150 m of the objective's hint; a collect objective needs at
 *   most 30 kills (count / chance) of its best source that lives near the hint.
 * Without the export the navmesh checks are skipped (report.nav = false).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { rewardCodeVariants, validateQuestFile, type QuestFile, type QuestRefs } from '../../../packages/shared/src/index.ts'
import { MeshNav, type NavPoint } from '../src/nav.ts'

export const REPO = resolve(import.meta.dirname, '../../..')

/** Server rules mirrored here (gameplay.ts NEST_SEARCH_M, config.ts MOB_LEVEL_MAX default, npc.ts HIDDEN_NPCS). */
const NEST_SEARCH_M = 20
const LEVEL_CAP = 20
const MOB_LEVEL_MAX = LEVEL_CAP + 5
const HIDDEN_NPCS: string[] = []
/** The server walks a talking player to this range (docs/SHOPS.md; WAVE_PLAN decision 3). */
const NPC_APPROACH_M = 3
/** An objective mob needs an accepted nest this close to the objective's hint. */
const HINT_NEST_M = 150
/** A collect objective's expected kills at its best source near the hint. */
const MAX_COLLECT_KILLS = 30

export interface CheckOptions {
  /** The quest file (default content/quests/jangan.json). */
  file?: string
  /** OUT_DIR (default work/out); the navmesh is also looked up in its sibling out-opt, as the server does. */
  outDir?: string
  /** The world export whose navmesh is checked (default jangan-fields, the play export). */
  worldExport?: string
}

export interface CheckReport {
  errors: string[]
  warnings: string[]
  /** Human-readable tables (EXP per level, nest distances). */
  lines: string[]
  /** Whether the navmesh checks ran. */
  nav: boolean
}

interface Json {
  [k: string]: any
}

const entries = (dir: string, name: string): Json[] => {
  const j = JSON.parse(readFileSync(join(dir, 'data', name), 'utf8'))
  return Array.isArray(j) ? j : j.entries
}

/** Whether the data exports and the world export's navmesh are present (the test skips without them). */
export function exportAvailable(opts: CheckOptions = {}): boolean {
  const out = opts.outDir ?? join(REPO, 'work/out')
  const world = opts.worldExport ?? 'jangan-fields'
  const data = ['mobs.json', 'nests.json', 'items.json', 'npcs.json', 'levels.json'].every((f) => existsSync(join(out, 'data', f)))
  return data && existsSync(join(out, 'world', world, 'manifest.json')) && existsSync(join(out, 'world', world, 'nav.bin'))
}

export function checkQuestContent(opts: CheckOptions = {}): CheckReport {
  const out = opts.outDir ?? join(REPO, 'work/out')
  const worldExport = opts.worldExport ?? 'jangan-fields'
  const raw = JSON.parse(readFileSync(opts.file ?? join(REPO, 'content/quests/jangan.json'), 'utf8'))
  const errors: string[] = []
  const warnings: string[] = []
  const lines: string[] = []

  const mobs = new Map<string, Json>(entries(out, 'mobs.json').map((m) => [m.code, m]))
  const items = new Map<string, Json>(entries(out, 'items.json').map((m) => [m.code, m]))
  const npcs = new Map<string, Json>(entries(out, 'npcs.json').map((m) => [m.code, m]))
  // The repo NPC override (content/npcs.override.json, layerRepoOverrides): moved and hidden NPCs, as the server sees them.
  try {
    const o = JSON.parse(readFileSync(join(REPO, 'content/npcs.override.json'), 'utf8')) as { patch?: Json[] }
    for (const p of o.patch ?? []) {
      const n = npcs.get(p.code)
      if (!n) continue
      if (p.hidden) npcs.delete(p.code)
      else npcs.set(p.code, { ...n, ...(p.x !== undefined ? { x: p.x } : {}), ...(p.z !== undefined ? { z: p.z } : {}), ...(p.y !== undefined ? { y: p.y } : {}) })
    }
  } catch {
    // no repo override
  }
  const levels = entries(out, 'levels.json') as { level: number; exp: number }[]
  const expToNext = (L: number) => levels.find((r) => r.level === L)?.exp ?? levels[L - 1]!.exp

  // ---- the shared validator (structure and references) ----
  const refs: QuestRefs = {
    mobs: new Set(mobs.keys()),
    items: new Set(items.keys()),
    npcs: new Set(npcs.keys()),
    levelCap: LEVEL_CAP,
    mobInfo: (c) => (mobs.has(c) ? { level: mobs.get(c)!.level, unique: mobs.get(c)!.rarity === 'unique' } : undefined),
    itemReqLevel: (c) => items.get(c)?.reqLevel,
  }
  const { file, issues } = validateQuestFile(raw, refs)
  for (const i of issues) (i.severity === 'error' ? errors : warnings).push(`validator ${i.path}: ${i.message}`)
  if (!file) return { errors, warnings, lines, nav: false }
  const Q: QuestFile = file
  const locs = new Map(Q.locations.map((l) => [l.id, l]))

  // ---- codes ----
  const usedNpcs = new Set<string>()
  for (const q of Q.quests) {
    usedNpcs.add(q.giver).add(q.turnIn)
    for (const o of q.objectives) if (o.type === 'talk' || o.type === 'deliver') usedNpcs.add(o.npc)
  }
  for (const c of usedNpcs) {
    const n = npcs.get(c)
    if (!n) errors.push(`npc ${c}: not in npcs.json`)
    else if (n.world !== Q.world) errors.push(`npc ${c}: world ${n.world}, not ${Q.world}`)
    else if (HIDDEN_NPCS.includes(c)) errors.push(`npc ${c}: hidden by the server`)
  }
  let iconIndex: Record<string, string> | null = null
  try {
    iconIndex = JSON.parse(readFileSync(join(out, 'icons', 'index.json'), 'utf8')).items ?? null
  } catch {
    iconIndex = null
  }
  const qnoExported = !!iconIndex && Object.keys(iconIndex).some((k) => k.startsWith('ITEM_QNO_'))
  for (const it of Q.items) {
    if (!it.iconItem) warnings.push(`item ${it.code}: no iconItem (generic icon)`)
    else if (!qnoExported) warnings.push(`item ${it.code}: icons/index.json has no ITEM_QNO_* icons yet (run export-icons)`)
    else if (!iconIndex![it.iconItem]) errors.push(`item ${it.code}: iconItem ${it.iconItem} not in icons/index.json`)
  }

  // ---- levels, rewards, prerequisites ----
  const byId = new Map(Q.quests.map((q) => [q.id, q]))
  for (const q of Q.quests) {
    const e = (m: string) => errors.push(`${q.id}: ${m}`)
    const repeatable = q.kind === 'repeatable'
    const top = repeatable ? (q.maxLevel ?? q.level + 3) : q.level + 3
    for (const o of q.objectives) {
      const list = o.type === 'kill' ? o.mobs : o.type === 'collect' ? o.from.map((f) => f.mob) : []
      for (const m of list) {
        const def = mobs.get(m)
        if (!def) continue
        const encounter = q.objectives.some((x) => x.type === 'useItem' && x.encounter?.mob === m)
        if (def.level > top && !(encounter && def.rarity === 'unique')) e(`${o.id}: ${def.name} is level ${def.level}, above ${top}`)
        if (def.level > MOB_LEVEL_MAX) e(`${o.id}: ${m} is level ${def.level}, above MOB_LEVEL_MAX ${MOB_LEVEL_MAX} (never spawned)`)
      }
      if (o.type === 'useItem' && o.encounter) {
        const def = mobs.get(o.encounter.mob)
        if (def && def.level > LEVEL_CAP + 5) e(`${o.id}: encounter ${o.encounter.mob} level ${def.level}`)
      }
      if (o.type === 'deliver' && !Q.items.some((i) => i.code === o.item) && !items.has(o.item)) e(`${o.id}: deliver item ${o.item}`)
    }
    for (const r of [...(q.rewards.items ?? []), ...(q.rewards.choice ?? [])]) {
      for (const c of rewardCodeVariants(r.item)) {
        const def = items.get(c)
        if (!def) e(`reward ${c} not in items.json`)
        else if ((def.reqLevel ?? 0) > q.level + 2) e(`reward ${c} needs level ${def.reqLevel}, above ${q.level}+2`)
      }
    }
    for (const r of q.requires?.quests ?? []) {
      const rq = byId.get(r)
      if (rq && rq.level > q.level) e(`requires ${r} of level ${rq.level}, above its own ${q.level}`)
    }
    if (q.level > LEVEL_CAP || (q.maxLevel ?? 0) > LEVEL_CAP) e(`level above the cap ${LEVEL_CAP}`)
  }

  // ---- EXP and SP (QUESTS §3.4) ----
  const byLevel = new Map<number, number>()
  let total = 0
  let sp = 0
  let gold = 0
  for (const q of Q.quests) {
    const r = q.rewards
    if (q.kind === 'repeatable') {
      if (r.exp !== 0) errors.push(`${q.id}: a daily gives only a share of the level (exp must be 0)`)
      const pct = r.expPctOfLevel ?? 0
      if (pct < 1 || pct > 6) errors.push(`${q.id}: expPctOfLevel ${pct} outside 1-6`)
      continue
    }
    if ((r.expPctOfLevel ?? 0) !== 0) errors.push(`${q.id}: expPctOfLevel is for dailies only`)
    const want = Math.max(1, Math.round(r.exp / 600))
    if (r.sp !== want) errors.push(`${q.id}: sp ${r.sp}, the rule gives ${want}`)
    total += r.exp
    sp += r.sp
    gold += r.gold
    byLevel.set(q.level, (byLevel.get(q.level) ?? 0) + r.exp)
  }
  let climb = 0
  lines.push('level  levels[L].exp  quest EXP  share')
  for (let L = 1; L < LEVEL_CAP; L++) {
    const need = expToNext(L)
    climb += need
    const got = byLevel.get(L) ?? 0
    const share = got / need
    lines.push(`${String(L).padStart(5)}  ${String(need).padStart(13)}  ${String(got).padStart(9)}  ${(100 * share).toFixed(0)} %`)
    if (L < 8 && share < 0.3) errors.push(`level ${L}: quests give ${(100 * share).toFixed(0)} % of the level, below 30 %`)
    if (L >= 8 && (share < 0.25 || share > 0.4)) errors.push(`level ${L}: quests give ${(100 * share).toFixed(0)} % of the level, outside 25-40 %`)
  }
  const whole = total / climb
  lines.push(`total quest EXP ${total} of ${climb} (${(100 * whole).toFixed(1)} %), SP ${sp}, gold ${gold}`)
  if (whole < 0.2 || whole > 0.35) errors.push(`quests give ${(100 * whole).toFixed(1)} % of the 1 -> ${LEVEL_CAP} climb, outside 20-35 %`)

  // ---- the play export's navmesh ----
  if (!exportAvailable({ outDir: out, worldExport })) {
    warnings.push(`navmesh checks skipped: no ${worldExport} export under ${out}`)
    return { errors, warnings, lines, nav: false }
  }
  const { nav, problem } = MeshNav.load([out, join(out, '..', 'out-opt')], worldExport)
  if (!nav) {
    errors.push(`navmesh ${worldExport}: ${problem}`)
    return { errors, warnings, lines, nav: false }
  }
  const home = (p: NavPoint | null) => !!p && nav.inHome(p)

  for (const l of Q.locations) {
    const at = nav.locate(l.x, l.z, Infinity)
    if (!at) errors.push(`${l.id}: nav.locate finds no ground at (${l.x}, ${l.z})`)
    else if (!home(at)) errors.push(`${l.id}: not in the town spawn's walkable component (component ${nav.componentOf(at)})`)
    else if (!nav.place(l.x, l.z, NaN)) errors.push(`${l.id}: no open home ground at its centre (nav.place)`)
  }

  for (const c of usedNpcs) {
    const n = npcs.get(c)
    if (!n) continue
    // Gameplay.start: the NPC stands where the client puts it; its height comes from the navmesh.
    const at = nav.locate(n.x, n.z, n.y ?? Infinity) ?? nav.place(n.x, n.z, n.y ?? NaN, 5)
    if (!at) errors.push(`npc ${c} (${n.name}): not placed (no ground at ${n.x.toFixed(1)}, ${n.z.toFixed(1)})`)
    else if (!home(at) && !nav.place(n.x, n.z, NaN, NPC_APPROACH_M)) errors.push(`npc ${c} (${n.name}): no reachable ground within ${NPC_APPROACH_M} m`)
  }

  // The spawner's placement rule (gameplay.ts: nav.place with the nest's search radius, capped at NEST_SEARCH_M).
  const nests = entries(out, 'nests.json').filter((n) => n.world === Q.world && n.enabled !== false)
  const accepted = nests.filter((n) => {
    const m = mobs.get(n.mob)
    return !!m && m.level <= MOB_LEVEL_MAX && nav.place(n.x, n.z, n.y ?? NaN, Math.min(NEST_SEARCH_M, Math.max(n.radius, n.spawnRadius))) !== null
  })
  lines.push(`nests of ${Q.world}: ${nests.length}, accepted by the spawner on ${worldExport}: ${accepted.length}`)
  const near = (mob: string, x: number, z: number) =>
    accepted
      .filter((n) => n.mob === mob)
      .map((n) => ({ n, d: Math.hypot(n.x - x, n.z - z) }))
      .sort((a, b) => a.d - b.d)

  for (const q of Q.quests) {
    for (const o of q.objectives) {
      if (o.type !== 'kill' && o.type !== 'collect') continue
      const list = o.type === 'kill' ? o.mobs : o.from.map((f) => f.mob)
      const hint = o.hint ? locs.get(o.hint) : undefined
      if (!hint) {
        const fromEncounter = list.every((m) => q.objectives.some((x) => x.type === 'useItem' && x.encounter?.mob === m && o.after === x.id))
        if (!fromEncounter) errors.push(`${q.id}.${o.id}: a mob objective needs a hint location`)
        continue
      }
      let bestKills = Infinity
      for (const m of list) {
        const found = near(m, hint.x, hint.z)
        const close = found.filter((f) => f.d <= HINT_NEST_M)
        const count = close.reduce((s, f) => s + f.n.count, 0)
        const name = mobs.get(m)?.name ?? m
        lines.push(`${q.id}.${o.id} ${o.hint} ${name}: nearest ${found[0] ? `${found[0].d.toFixed(0)} m` : 'none'}, ${close.length} nests / ${count} mobs within ${HINT_NEST_M} m`)
        if (!found.length) errors.push(`${q.id}.${o.id}: ${name} (${m}) has no nest the server spawns on ${worldExport}`)
        else if (!close.length) errors.push(`${q.id}.${o.id}: nearest ${name} nest is ${found[0]!.d.toFixed(0)} m from ${o.hint}, over ${HINT_NEST_M} m`)
        if (o.type === 'collect' && close.length) {
          const chance = o.from.find((f) => f.mob === m)!.chance
          bestKills = Math.min(bestKills, o.count / chance)
        }
      }
      if (o.type === 'collect' && bestKills > MAX_COLLECT_KILLS) errors.push(`${q.id}.${o.id}: ${bestKills.toFixed(0)} kills expected at the best source near ${o.hint}, over ${MAX_COLLECT_KILLS}`)
    }
  }
  return { errors, warnings, lines, nav: true }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2)
  const w = args.indexOf('--world')
  const worldExport = w >= 0 ? args[w + 1] : undefined
  const file = args.find((a, i) => !a.startsWith('--') && (w < 0 || i !== w + 1))
  const r = checkQuestContent({ file: file && resolve(file), worldExport })
  for (const l of r.lines) console.log(l)
  console.log(`\nnavmesh checks: ${r.nav ? 'ran' : 'skipped'}`)
  console.log(`WARNINGS ${r.warnings.length}`)
  for (const m of r.warnings) console.log(`  ${m}`)
  console.log(`ERRORS ${r.errors.length}`)
  for (const m of r.errors) console.log(`  ${m}`)
  process.exitCode = r.errors.length ? 1 : 0
}
