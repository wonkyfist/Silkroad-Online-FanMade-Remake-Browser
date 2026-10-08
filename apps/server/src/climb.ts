/**
 * The Climb to 25 on the server (docs/CLIMB.md §20 layers L0 and L1; the pure rules are packages/shared/src/climb.ts):
 *
 * - `applyClimbContent` (startup, before the repo overrides): the derived `MOB_CL_*` monsters and their drop tables
 *   join the export's (from level 21 their degree-3 gear drops come as degree 4, §4.4), every degree's required levels
 *   are spaced inside the cap (§4.1.2: D1 1–8, D2 8–15, D3 15–21, D4 21–25), and CONTENT_DIR/climb/levels.json replaces
 *   the `exp` column of levels.json (§3.2a; masterySp stays the export's). Returns the curve it replaced, for the
 *   character conversion.
 * - `remapClimbNests` (after the repo overrides, before the GM layer captures the content): every nest's retail code
 *   becomes the derived code of its band (§2.2): its region's high-country place (CLIMB_PLACES) first, else its area's;
 *   the GM editors then see the remapped nests as the export.
 * - `convertClimbCharacters` (startup, after both): the one-time move of saved characters to the new curve (§9.2,
 *   §9.3a; characters.curve_version, migration 21). Level 20s start the 20 → 21 bar at 0 %, the rest keep the
 *   fraction of their bar; level, SP, skills, items and quests are untouched.
 * - `climbGm`: the GM `climb` command (§10.4; `climb gear`: the gear levels of §4.1.2).
 *
 * CLIMB=off (config.climb false) skips all of it: retail monsters, the export's curve, no level rule.
 */
import { join } from 'node:path'
import {
  CLIMB_BANDS,
  CLIMB_CURVE_VERSION,
  CLIMB_DEGREE_LEVELS,
  CLIMB_LEVELS_FILE,
  CLIMB_PLACES,
  CLIMB_BOSSES,
  CLIMB_ROSTER,
  CLIMB_TIERS,
  PRE_CLIMB_CAP,
  applyClimbItemLevels,
  checkClimbLevels,
  climbBandAt,
  climbCodeFor,
  climbRegionOf,
  convertBarExp,
  deriveClimbDrops,
  deriveClimbMobs,
  levelDiffExpMul,
  type MobDef,
} from '@sro/shared'
import type Database from 'better-sqlite3'
import type { GameData } from './gamedata.ts'
import { readJsonFile } from './editors/overrides.ts'
import type { GmResult } from './gm.ts'

export const CLIMB_USAGE = 'climb | climb mob <code> | climb exp <player level> <monster level> | climb gear [item code]'

export interface ClimbContent {
  /** The export's EXP per level before the climb curve replaced it (levels.json), index = level − 1. */
  oldNeed: number[]
  /** Derived monsters added. */
  mobs: number
  /** Items whose required level moved. */
  items: number
  /** Levels the curve file holds (0: no file, the export's curve stays). */
  levels: number
}

/** Startup: derived monsters and drops, the item re-spacing and the cap-25 curve. Never throws (a bad file is logged). */
export function applyClimbContent(data: GameData, contentDir: string | undefined, log: (line: string) => void): ClimbContent {
  const oldNeed = data.levels.map((l) => l.exp)
  const derived = deriveClimbMobs(data.mobs)
  for (const d of derived) {
    data.mobs.set(d.code, d)
    // a mini-boss (§2.5) drops its uniques.json table, never its base's row
    const row = CLIMB_ROSTER.find((r) => r.code === d.code)
    const table = row ? deriveClimbDrops(data.drops.get(d.base!), row, (c) => data.items.has(c)) : null
    if (table) data.drops.set(d.code, table)
  }
  const missing = CLIMB_ROSTER.length + CLIMB_BOSSES.length - derived.length
  const items = applyClimbItemLevels(data.items)
  let levels = 0
  if (contentDir) {
    const file = join(contentDir, CLIMB_LEVELS_FILE)
    const r = readJsonFile(file)
    if ('error' in r) log(`climb: skipped ${file}: ${r.error}`)
    else if ('json' in r) {
      const c = checkClimbLevels(r.json)
      if ('problems' in c) log(`climb: skipped ${file}: ${c.problems.slice(0, 3).join('; ')}`)
      else {
        c.exp.forEach((exp, i) => {
          const row = data.levels[i]
          if (row) data.levels[i] = { ...row, exp }
          else data.levels.push({ level: i + 1, exp, masterySp: data.levels.at(-1)?.masterySp ?? 0 })
        })
        levels = c.exp.length
      }
    }
  }
  const total = data.levels.slice(0, levels).reduce((s, l) => s + l.exp, 0)
  log(
    `climb: ${derived.length} derived monsters${missing ? ` (${missing} without their base in mobs.json)` : ''}, ${items} item levels re-spaced, ` +
      (levels ? `curve 1 -> ${levels + 1} = ${total.toLocaleString('en-US')} EXP` : 'no climb curve (the export curve stays)'),
  )
  return { oldNeed, mobs: derived.length, items, levels }
}

/**
 * The area remap (§2.2): every nest whose retail code has a row for its area's band (or the nearest band) takes the
 * derived code. Nests already holding a derived code (a repo `mob` patch) and unique groups are left alone. Returns the
 * number of nests changed.
 */
export function remapClimbNests(data: GameData, log: (line: string) => void): number {
  let n = 0
  const byBand = new Map<string, number>()
  data.nests.forEach((nest, i) => {
    if (nest.uniqueGroup || nest.mob.startsWith('MOB_CL_')) return
    const area = nest.region !== undefined ? (data.zones.get(nest.region)?.name ?? null) : null
    const mob = data.mob(nest.mob)
    const region = climbRegionOf(nest.region)
    const code = climbCodeFor(area, nest.mob, nest.level ?? mob?.level ?? 0, region)
    const def = code ? data.mob(code) : undefined
    if (!def || code === nest.mob) return
    data.nests[i] = { ...nest, mob: def.code, level: def.level }
    n++
    const band = climbBandAt(area, region)?.id ?? 'nearest band'
    byBand.set(band, (byBand.get(band) ?? 0) + 1)
  })
  log(`climb: ${n} nests re-levelled (${[...byBand].sort().map(([b, c]) => `${b} ${c}`).join(', ') || 'none'})`)
  return n
}

/**
 * The one-time move of every saved character to the new curve (§9.2, §9.3a), in one transaction: characters with
 * curve_version < CLIMB_CURVE_VERSION get `convertBarExp` and the new version. Returns how many rows moved.
 */
export function convertClimbCharacters(db: Database.Database, oldNeed: (level: number) => number, newNeed: (level: number) => number, log: (line: string) => void): number {
  const rows = db.prepare<[number], { id: number; level: number; exp: number }>('SELECT id, level, exp FROM characters WHERE curve_version < ?').all(CLIMB_CURVE_VERSION)
  if (rows.length === 0) return 0
  const set = db.prepare<[number, number, number]>('UPDATE characters SET exp = ?, curve_version = ? WHERE id = ?')
  let atCap = 0
  db.transaction(() => {
    for (const r of rows) {
      if (r.level === PRE_CLIMB_CAP) atCap++
      set.run(convertBarExp(r.level, r.exp, oldNeed(r.level), newNeed(r.level)), CLIMB_CURVE_VERSION, r.id)
    }
  })()
  log(`climb: ${rows.length} characters moved to the cap-25 curve (${atCap} at level ${PRE_CLIMB_CAP} start the next bar at 0 %; the rest keep their bar fraction)`)
  return rows.length
}

const fmt = (n: number) => n.toLocaleString('en-US')
const statLine = (d: MobDef) => {
  const atk = d.physAttack[1] > 0 ? `phys ${d.physAttack[0]}-${d.physAttack[1]}` : `mag ${d.magAttack[0]}-${d.magAttack[1]}`
  return `level ${d.level}, HP ${fmt(d.hp)}, ${atk}, def ${d.physDefence}/${d.magDefence}, hit ${d.hitRate}, EXP ${fmt(d.exp)}`
}

/** GM `climb`: the cap, the curve and the roster; `climb mob <code>`: a derived row against its base; `climb exp`. */
export function climbGm(ctx: { data: GameData; config: { levelCap: number; climb?: boolean }; nests: () => number }, args: string[]): GmResult {
  const { data, config } = ctx
  const [verb, a, b] = args
  if (verb === undefined) {
    const total = data.levels.slice(0, config.levelCap - 1).reduce((s, l) => s + l.exp, 0)
    const derived = CLIMB_ROSTER.filter((r) => data.mobs.has(r.code)).length
    const bands = CLIMB_BANDS.filter((x) => x.areas.length || CLIMB_PLACES.some((p) => p.band === x.id)).map((x) => `${x.id} ${x.levels[0]}-${x.levels[1]}`).join(', ')
    return {
      ok: true,
      message: `The Climb is ${config.climb === false ? 'OFF (CLIMB=off)' : 'on'}: level cap ${config.levelCap}, 1 -> ${config.levelCap} = ${fmt(total)} EXP; ${derived}/${CLIMB_ROSTER.length} derived monsters, ${ctx.nests()} nests on them; bands ${bands}.`,
      data: { climb: config.climb !== false, levelCap: config.levelCap, curveTotal: total, derived, nests: ctx.nests() },
    }
  }
  if (verb === 'mob' && a && args.length === 2) {
    const code = a.toUpperCase()
    const d = data.mob(code)
    if (!d) return { ok: false, message: `No monster ${code}.` }
    const base = d.base ? data.mob(d.base) : undefined
    const row = CLIMB_ROSTER.find((r) => r.code === code)
    const derivedFrom = CLIMB_ROSTER.filter((r) => r.base === code).map((r) => `${r.code} (${r.level})`)
    const lines = [`${d.name ?? d.code} (${d.code}): ${statLine(d)}${row ? `; band ${row.band}${row.roles?.length ? `, roles ${row.roles.join('/')}` : ''}` : ''}`]
    if (base) lines.push(`  base ${base.code}: ${statLine(base)}; HP x${(d.hp / base.hp).toFixed(2)}`)
    if (derivedFrom.length) lines.push(`  derived rows: ${derivedFrom.join(', ')}`)
    return { ok: true, message: lines.join('\n'), data: { code: d.code, level: d.level, hp: d.hp, base: d.base ?? null } }
  }
  // §4.1.2 (D53): the degrees' spans and the tiers; with a code, one item's level (the client's and the Climb's)
  if (verb === 'gear' && args.length <= 2) {
    if (a) {
      const it = data.items.get(a.toUpperCase())
      if (!it) return { ok: false, message: `No item ${a.toUpperCase()}.` }
      const moved = it.retailReqLevel !== undefined ? ` (retail ${it.retailReqLevel})` : ' (unmoved)'
      return { ok: true, message: `${it.name ?? it.code} (${it.code}): degree ${it.degree}, required level ${it.reqLevel}${moved}.`, data: { code: it.code, degree: it.degree, reqLevel: it.reqLevel, retailReqLevel: it.retailReqLevel ?? null } }
    }
    const spans = Object.entries(CLIMB_DEGREE_LEVELS).map(([d, x]) => {
      const n = [...data.items.values()].filter((i) => i.degree === Number(d) && /^ITEM_CH_/.test(i.code) && i.category !== 'alchemy').length
      return `D${d} ${x.climb[0]}-${x.climb[1]} (retail ${x.retail[0]}-${x.retail[1]}, ${n} rows)`
    })
    const tiers = CLIMB_TIERS.map((t) => `${t.id} D${t.degree} ${t.grades} ${t.levels[0]}-${t.levels[1]}`)
    return { ok: true, message: `Gear inside the cap${config.climb === false ? ' (CLIMB=off: retail levels)' : ''}: ${spans.join('; ')}.
Tiers: ${tiers.join('; ')}.`, data: { spans: CLIMB_DEGREE_LEVELS, tiers: CLIMB_TIERS.map((t) => t.id) } }
  }
  if (verb === 'exp' && args.length === 3) {
    const p = Number(a)
    const m = Number(b)
    if (!Number.isInteger(p) || !Number.isInteger(m) || p < 1 || m < 1) return { ok: false, message: `Usage: ${CLIMB_USAGE}` }
    const mul = levelDiffExpMul(p, m)
    return { ok: true, message: `A level-${p} player gets ${Math.round(mul * 100)} % of a level-${m} monster's EXP${config.climb === false ? ' (the rule is off: CLIMB=off)' : ''}.`, data: { mul } }
  }
  return { ok: false, message: `Usage: ${CLIMB_USAGE}` }
}
