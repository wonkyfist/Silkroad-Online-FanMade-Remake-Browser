/**
 * Light runtime checks for content records (content.ts), for the exporter's self-check and the server's loader.
 * Each check returns a list of problems (empty = the required fields are present and well-typed); extra keys are
 * allowed. Environment-neutral.
 */

import {
  CONTENT_FILES,
  EQUIP_SLOTS,
  ITEM_CATEGORIES,
  MOB_RARITIES,
  MOB_VARIANTS,
  PER_PLUS_STATS,
  PROVENANCE_PORT,
  UNIQUES_FILE,
  contentEntries,
  type ContentKind,
} from './content.ts'
import { checkPilotDef } from './pilot.ts'

type Problems = string[]

const CODE_RE = /^[A-Z0-9_]{1,128}$/

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

class Checker {
  readonly problems: Problems = []
  constructor(readonly o: Record<string, unknown>, readonly where: string) {}

  private bad(k: string, what: string): void {
    this.problems.push(`${this.where}.${k}: ${what}`)
  }

  str(k: string, opt = false, nullable = false): void {
    const v = this.o[k]
    if (v === undefined && opt) return
    if (v === null && nullable) return
    if (typeof v !== 'string' || v.length === 0) this.bad(k, 'expected a non-empty string')
  }

  /** A string (empty allowed) of at most `max` characters. */
  text(k: string, max: number, opt = false): void {
    const v = this.o[k]
    if (v === undefined && opt) return
    if (typeof v !== 'string' || v.length > max) this.bad(k, `expected a string of at most ${max} characters`)
  }

  code(k: string, opt = false): void {
    const v = this.o[k]
    if (v === undefined && opt) return
    if (typeof v !== 'string' || !/^[A-Z0-9_]{1,128}$/.test(v)) this.bad(k, 'expected a CodeName128 id')
  }

  num(k: string, opt = false, min = -Infinity): void {
    const v = this.o[k]
    if (v === undefined && opt) return
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min) this.bad(k, `expected a finite number >= ${min}`)
  }

  bool(k: string, opt = false): void {
    const v = this.o[k]
    if (v === undefined && opt) return
    if (typeof v !== 'boolean') this.bad(k, 'expected a boolean')
  }

  range(k: string, opt = false): void {
    const v = this.o[k]
    if (v === undefined && opt) return
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n)) || v[0] > v[1]) {
      this.bad(k, 'expected [min, max] with min <= max')
    }
  }

  oneOf(k: string, values: readonly unknown[], opt = false): void {
    const v = this.o[k]
    if (v === undefined && opt) return
    if (!values.includes(v)) this.bad(k, `expected one of ${values.join(', ')}`)
  }

  model(k: string): void {
    const v = this.o[k]
    if (v === null) return
    if (!isObj(v) || typeof v.glb !== 'string' || typeof v.sidecar !== 'string' || typeof v.bsr !== 'string') this.bad(k, 'expected null or {bsr, glb, sidecar}')
  }
}

export function checkMobDef(v: unknown, where = 'mob'): Problems {
  if (!isObj(v)) return [`${where}: expected an object`]
  const c = new Checker(v, where)
  c.code('code')
  c.num('id')
  c.str('name', false, true)
  c.oneOf('rarity', MOB_RARITIES)
  for (const k of ['level', 'hp', 'mp', 'physDefence', 'magDefence', 'hitRate', 'parryRate', 'attackRange', 'attackIntervalMs', 'radius', 'walkSpeed', 'runSpeed', 'exp', 'scale']) c.num(k, false, 0)
  c.range('physAttack')
  c.range('magAttack')
  c.bool('aggressive')
  c.bool('championAggressive', true)
  c.num('spExp', true, 0)
  c.model('model')
  if (v.ride !== undefined) c.problems.push(...checkMobRide(v.ride, `${where}.ride`))
  return c.problems
}

/** MobDef.ride (wave 11, docs/UNIQUES.md §2.2): {model: a ModelRef under /out/, joint: a non-empty joint name}. */
export function checkMobRide(v: unknown, where = 'ride'): Problems {
  if (!isObj(v)) return [`${where}: expected {model, joint}`]
  const c = new Checker(v, where)
  const m = v.model
  if (!isObj(m) || typeof m.bsr !== 'string' || typeof m.glb !== 'string' || typeof m.sidecar !== 'string') c.problems.push(`${where}.model: expected {bsr, glb, sidecar}`)
  else if (!m.glb.startsWith('/out/') || !m.glb.endsWith('.glb')) c.problems.push(`${where}.model.glb: expected a .glb path under /out/`)
  c.str('joint')
  return c.problems
}

export function checkNestDef(v: unknown, where = 'nest'): Problems {
  if (!isObj(v)) return [`${where}: expected an object`]
  const c = new Checker(v, where)
  c.num('id')
  c.code('mob')
  c.num('x')
  c.num('z')
  c.num('y', true)
  c.num('radius', false, 0)
  c.num('spawnRadius', false, 0)
  c.num('count', false, 1)
  c.range('respawnSec')
  c.num('championPct', true, 0)
  c.str('world')
  c.oneOf('provenance', [PROVENANCE_PORT])
  c.bool('enabled', true)
  c.num('level', true, 0)
  c.bool('inConvertedRegion', true)
  c.str('uniqueGroup', true)
  if (!isObj(v.tactics)) c.problems.push(`${where}.tactics: expected an object`)
  else {
    const t = new Checker(v.tactics, `${where}.tactics`)
    t.num('id')
    t.bool('aggressive')
    t.num('sightRange', false, 0)
    t.num('leashRange', false, 0)
    c.problems.push(...t.problems)
  }
  if (!isObj(v.source)) c.problems.push(`${where}.source: expected an object`)
  return c.problems
}

export function checkItemDef(v: unknown, where = 'item'): Problems {
  if (!isObj(v)) return [`${where}: expected an object`]
  const c = new Checker(v, where)
  c.code('code')
  c.num('id')
  c.str('name', false, true)
  c.oneOf('category', ITEM_CATEGORIES)
  c.oneOf('slot', [...EQUIP_SLOTS.filter((s) => s !== 'ring1' && s !== 'ring2'), 'ring'], true)
  for (const k of ['degree', 'reqLevel', 'price', 'sellPrice']) c.num(k, false, 0)
  c.num('maxStack', false, 1)
  c.oneOf('reqGender', ['male', 'female', 'any'])
  c.oneOf('race', ['china', 'europe', 'any'])
  c.model('model')
  c.str('icon', false, true)
  if ((v.category === 'weapon' || v.category === 'shield' || v.category === 'armor' || v.category === 'accessory') && v.slot === undefined) {
    c.problems.push(`${where}.slot: equipment needs a slot`)
  }
  // wave 3 (docs/SHOPS.md §7.5): optional
  for (const k of ['keepFee', 'repairCost', 'cureLevel']) c.num(k, true, 0)
  c.bool('canRepair', true)
  c.bool('canStore', true)
  // wave 8 (docs/SYSTEMS_COMBAT.md §6.3, docs/SYSTEMS_SOCIAL.md §8): optional
  c.bool('canTrade', true)
  if (v.perPlus !== undefined) {
    if (!isObj(v.perPlus)) c.problems.push(`${where}.perPlus: expected an object`)
    else {
      const pp = new Checker(v.perPlus, `${where}.perPlus`)
      for (const k of Object.keys(v.perPlus)) {
        if (!(PER_PLUS_STATS as readonly string[]).includes(k)) pp.problems.push(`${where}.perPlus.${k}: unknown stat`)
        else pp.num(k)
      }
      c.problems.push(...pp.problems)
    }
  }
  if (v.reinforce !== undefined) c.problems.push(...checkReinforce(v.reinforce, `${where}.reinforce`))
  if (isObj(v.use)) {
    const u = new Checker(v.use, `${where}.use`)
    u.code('summon', true)
    u.oneOf('target', ['mount'], true)
    c.problems.push(...u.problems)
  }
  return c.problems
}

/** ItemDef.reinforce (wave 8): {kind, targets?, degree?, rates[12]}. */
function checkReinforce(v: unknown, where: string): Problems {
  if (!isObj(v)) return [`${where}: expected an object`]
  const c = new Checker(v, where)
  c.oneOf('kind', ['elixir', 'powder'])
  if (v.targets !== undefined && (!Array.isArray(v.targets) || !v.targets.every((n) => Number.isInteger(n) && n >= 0))) c.problems.push(`${where}.targets: expected integers >= 0`)
  c.num('degree', true, 1)
  if (!Array.isArray(v.rates) || !v.rates.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) c.problems.push(`${where}.rates: expected numbers >= 0`)
  return c.problems
}

/** cos.json record (content.ts CosDef; wave 8, docs/SYSTEMS_COMBAT.md §6.3). */
export function checkCosDef(v: unknown, where = 'cos'): Problems {
  if (!isObj(v)) return [`${where}: expected an object`]
  const c = new Checker(v, where)
  c.code('code')
  c.num('id')
  c.str('name', false, true)
  for (const k of ['level', 'walkSpeed', 'runSpeed', 'radius', 'physAbsorb', 'magAbsorb', 'parryRate', 'hitRate']) c.num(k, false, 0)
  c.num('hp', false, 1)
  c.model('model')
  c.str('icon', false, true)
  return c.problems
}

/** Optional NpcDef fields of wave 3 (npcs.json has no full checker yet). */
export function checkNpcDef(v: unknown, where = 'npc'): Problems {
  if (!isObj(v)) return [`${where}: expected an object`]
  const c = new Checker(v, where)
  c.code('code')
  c.text('greeting', 2000, true)
  return c.problems
}

/** zones.json record (content.ts ZoneDef; docs/FIELDS.md §6.2). */
export function checkZoneDef(v: unknown, where = 'zone'): Problems {
  if (!isObj(v)) return [`${where}: expected an object`]
  const c = new Checker(v, where)
  for (const k of ['region', 'rx', 'rz']) {
    const n = v[k]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) c.problems.push(`${where}.${k}: expected an integer >= 0`)
  }
  if (typeof v.region === 'number' && typeof v.rx === 'number' && typeof v.rz === 'number' && v.region !== ((v.rz << 8) | v.rx)) {
    c.problems.push(`${where}.region: expected rz << 8 | rx`)
  }
  c.text('name', 64)
  if (v.area !== null && (typeof v.area !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(v.area))) {
    c.problems.push(`${where}.area: expected null or a code of at most 64 characters`)
  }
  if (v.continent !== null) c.str('continent')
  c.str('town', true)
  return c.problems
}

export function checkDropTable(v: unknown, where = 'drop'): Problems {
  if (!isObj(v)) return [`${where}: expected an object`]
  const c = new Checker(v, where)
  c.code('mob')
  if (v.gold !== undefined) {
    if (!isObj(v.gold)) c.problems.push(`${where}.gold: expected an object`)
    else {
      const g = new Checker(v.gold, `${where}.gold`)
      g.num('chance', false, 0)
      g.range('amount')
      c.problems.push(...g.problems)
    }
  }
  if (!Array.isArray(v.groups)) c.problems.push(`${where}.groups: expected an array`)
  else v.groups.forEach((grp, i) => {
    if (!isObj(grp) || !Array.isArray(grp.entries)) return c.problems.push(`${where}.groups[${i}]: expected {chance, entries[]}`)
    const g = new Checker(grp, `${where}.groups[${i}]`)
    g.num('chance', false, 0)
    grp.entries.forEach((e, j) => {
      if (!isObj(e)) return g.problems.push(`${where}.groups[${i}].entries[${j}]: expected an object`)
      const ec = new Checker(e, `${where}.groups[${i}].entries[${j}]`)
      ec.code('item')
      ec.num('weight', false, 0)
      ec.range('count', true)
      g.problems.push(...ec.problems)
    })
    c.problems.push(...g.problems)
  })
  c.str('provenance')
  return c.problems
}

export function checkLevelDef(v: unknown, where = 'level'): Problems {
  if (!isObj(v)) return [`${where}: expected an object`]
  const c = new Checker(v, where)
  c.num('level', false, 1)
  c.num('exp', false, 0)
  c.num('masterySp', false, 0)
  return c.problems
}

/** What checkUniquesFile can resolve against (the server passes its loaded tables; absent = not checked). */
export interface UniquesCheckRefs {
  /** True when `code` is a MobDef code. */
  mob?: (code: string) => boolean
  /** True when `id` is a NestDef id (explicit camp lists). */
  nest?: (id: number) => boolean
  /** True when `code` is an ItemDef code (drop entries). */
  item?: (code: string) => boolean
  /** True when `code` is a skill row (Play the Boss kit rows; absent = not checked). */
  skill?: (code: string) => boolean
}

/**
 * content/uniques.json (wave 11, content.ts UniquesFile; docs/UNIQUES.md §5.3). Problems: a bad wrapper, an unknown
 * mob (with `refs.mob`), no camps, a bad range (min > max, negative), a missing drop table, bad chances or weights.
 * A unique listed twice is a problem too (one alive per mob code).
 */
export function checkUniquesFile(json: unknown, refs: UniquesCheckRefs = {}): Problems {
  const where = UNIQUES_FILE
  if (!isObj(json)) return [`${where}: expected an object`]
  const problems: Problems = []
  if (json.schema !== 1) problems.push(`${where}.schema: expected 1`)
  if (json.kind !== 'uniques') problems.push(`${where}.kind: expected 'uniques'`)
  const tables = isObj(json.dropTables) ? json.dropTables : null
  if (!tables) problems.push(`${where}.dropTables: expected an object`)
  else for (const [id, t] of Object.entries(tables)) problems.push(...checkUniqueDropTable(t, `${where}.dropTables.${id}`, refs))
  if (!Array.isArray(json.uniques)) return [...problems, `${where}.uniques: expected an array`]
  const seen = new Set<unknown>()
  json.uniques.forEach((u, i) => {
    const w = `${where}.uniques[${i}]`
    if (!isObj(u)) return problems.push(`${w}: expected an object`)
    const c = new Checker(u, w)
    c.code('mob')
    if (typeof u.mob === 'string' && refs.mob && !refs.mob(u.mob)) c.problems.push(`${w}.mob: unknown mob ${u.mob}`)
    if (seen.has(u.mob)) c.problems.push(`${w}.mob: listed twice`)
    seen.add(u.mob)
    c.str('world')
    // the Climb's mini-bosses (docs/CLIMB.md §2.5): an authored spot replaces the camps; adds replace the summon rows
    if (u.spot !== undefined) {
      if (!isObj(u.spot) || typeof u.spot.x !== 'number' || typeof u.spot.z !== 'number' || !Number.isFinite(u.spot.x) || !Number.isFinite(u.spot.z)) c.problems.push(`${w}.spot: expected { x, z, y?, radiusM?, sightM?, leashM? }`)
      else for (const k of ['y', 'radiusM', 'sightM', 'leashM']) if (u.spot[k] !== undefined && !(typeof u.spot[k] === 'number' && Number.isFinite(u.spot[k]) && (k === 'y' || (u.spot[k] as number) > 0))) c.problems.push(`${w}.spot.${k}: expected a number${k === 'y' ? '' : ' > 0'}`)
    }
    if (u.adds !== undefined) {
      if (!Array.isArray(u.adds)) c.problems.push(`${w}.adds: expected a list of { mob, n, atPct }`)
      else u.adds.forEach((a, j) => {
        if (!isObj(a) || typeof a.mob !== 'string' || !CODE_RE.test(a.mob) || !Number.isInteger(a.n) || (a.n as number) < 1 || (a.n as number) > 8 || typeof a.atPct !== 'number' || a.atPct <= 0 || a.atPct > 100) {
          c.problems.push(`${w}.adds[${j}]: expected { mob: a mob code, n: 1..8, atPct: 0 < pct <= 100 }`)
        }
      })
    }
    if (u.spot !== undefined) {
      // no camp list needed
    } else if (u.camps !== 'uniqueGroup') {
      if (!Array.isArray(u.camps) || u.camps.length === 0 || !u.camps.every((n) => Number.isInteger(n))) c.problems.push(`${w}.camps: expected 'uniqueGroup' or a non-empty list of nest ids`)
      else if (refs.nest) for (const n of u.camps as number[]) if (!refs.nest(n)) c.problems.push(`${w}.camps: unknown nest ${n}`)
    }
    for (const k of ['respawnMin', 'firstSpawnMin', 'restartSpawnMin']) {
      c.range(k)
      const r = u[k]
      if (Array.isArray(r) && typeof r[0] === 'number' && r[0] < 0) c.problems.push(`${w}.${k}: expected minutes >= 0`)
    }
    // the Climb (docs/CLIMB.md §2.6): an optional level of her own
    if (u.level !== undefined && !(Number.isInteger(u.level) && (u.level as number) >= 1 && (u.level as number) <= 300)) c.problems.push(`${w}.level: expected a whole level 1..300`)
    sub(c, u, 'tuning', (t) => ['hpMul', 'attackMul', 'expMul'].forEach((k) => t.num(k, false, 0)))
    sub(c, u, 'summons', (t) => {
      t.bool('on')
      t.num('perWave', false, 0)
      t.num('maxAlive', false, 0)
      const vs = t.o.variants
      if (!Array.isArray(vs) || !vs.every((x) => (MOB_VARIANTS as readonly unknown[]).includes(x))) t.problems.push(`${t.where}.variants: expected a list of mob variants`)
      const ms = t.o.mobs
      if (ms !== undefined) {
        if (!isObj(ms)) t.problems.push(`${t.where}.mobs: expected { retail code: summoned code }`)
        else for (const [from, to] of Object.entries(ms)) {
          // shape only: a code this world lacks (CLIMB=off: no MOB_CL_* rows) summons the row's own monster
          if (typeof to !== 'string' || !CODE_RE.test(to) || !CODE_RE.test(from)) t.problems.push(`${t.where}.mobs.${from}: expected a mob code`)
        }
      }
    })
    sub(c, u, 'enrage', (t) => {
      t.num('hpPct', false, 0)
      if (typeof t.o.hpPct === 'number' && t.o.hpPct > 100) t.problems.push(`${t.where}.hpPct: expected 0..100`)
      t.num('damageMul', false, 0)
    })
    sub(c, u, 'fury', (t) => {
      t.num('afterSec', false, 0)
      t.num('damageMul', false, 0)
    })
    c.num('corpseSec', false, 0)
    sub(c, u, 'announce', (t) => {
      t.bool('appear')
      t.bool('defeat')
      t.num('roarRadiusM', false, 0)
    })
    c.str('drops')
    if (typeof u.drops === 'string' && tables && !(u.drops in tables)) c.problems.push(`${w}.drops: no drop table ${u.drops}`)
    // Play the Boss (docs/PLAY_THE_BOSS.md §5.5): the optional `pilot` block.
    // Its shape only: a kit row or pack mob missing from this world's tables leaves that ability out at start (logged).
    if (u.pilot !== undefined) c.problems.push(...checkPilotDef(u.pilot, `${w}.pilot`, { skill: refs.skill }))
    problems.push(...c.problems)
  })
  return problems
}

function sub(c: Checker, o: Record<string, unknown>, k: string, check: (t: Checker) => void): void {
  const v = o[k]
  if (!isObj(v)) return void c.problems.push(`${c.where}.${k}: expected an object`)
  const t = new Checker(v, `${c.where}.${k}`)
  check(t)
  c.problems.push(...t.problems)
}

function checkUniqueDropTable(v: unknown, where: string, refs: UniquesCheckRefs): Problems {
  if (!isObj(v)) return [`${where}: expected an object`]
  const c = new Checker(v, where)
  if (v.gold !== undefined) {
    sub(c, v, 'gold', (g) => {
      g.num('chance', false, 0)
      if (typeof g.o.chance === 'number' && g.o.chance > 1) g.problems.push(`${g.where}.chance: expected 0..1`)
      g.num('piles', false, 1)
      g.range('amount')
    })
  }
  if (!Array.isArray(v.groups)) return [...c.problems, `${where}.groups: expected an array`]
  v.groups.forEach((grp, i) => {
    const w = `${where}.groups[${i}]`
    if (!isObj(grp)) return c.problems.push(`${w}: expected an object`)
    const g = new Checker(grp, w)
    g.num('chance', false, 0)
    if (typeof grp.chance === 'number' && grp.chance > 1) g.problems.push(`${w}.chance: expected 0..1`)
    g.num('rolls', true, 1)
    const hasEntries = Array.isArray(grp.entries) && grp.entries.length > 0
    if (hasEntries === (grp.pool !== undefined)) g.problems.push(`${w}: expected either entries[] or a pool`)
    if (Array.isArray(grp.entries)) grp.entries.forEach((e, j) => {
      if (!isObj(e)) return g.problems.push(`${w}.entries[${j}]: expected an object`)
      const ec = new Checker(e, `${w}.entries[${j}]`)
      ec.code('item')
      if (typeof e.item === 'string' && refs.item && !refs.item(e.item)) ec.problems.push(`${w}.entries[${j}].item: unknown item ${e.item}`)
      ec.num('weight', false, 0)
      ec.range('count', true)
      g.problems.push(...ec.problems)
    })
    if (grp.pool !== undefined) sub(g, grp, 'pool', (p) => {
      p.num('degree', false, 1)
      if (p.o.maxReqLevel !== 'levelCap') p.num('maxReqLevel', false, 1)
      const gw = p.o.gradeWeights
      if (gw !== undefined && (!Array.isArray(gw) || gw.length === 0 || !gw.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0))) p.problems.push(`${p.where}.gradeWeights: expected weights >= 0`)
      p.bool('rare', true)
      if (p.o.seal !== undefined && !['star', 'moon', 'sun'].includes(p.o.seal as string)) p.problems.push(`${p.where}.seal: expected star, moon or sun`)
      if (p.o.seal !== undefined && p.o.rare !== true) p.problems.push(`${p.where}.seal: only with rare: true`)
    })
    if (grp.plus !== undefined) {
      if (!Array.isArray(grp.plus) || grp.plus.length === 0) g.problems.push(`${w}.plus: expected a non-empty list`)
      else grp.plus.forEach((pl, j) => {
        if (!isObj(pl) || !Number.isInteger(pl.plus) || (pl.plus as number) < 0 || typeof pl.weight !== 'number' || !(pl.weight >= 0)) g.problems.push(`${w}.plus[${j}]: expected {plus: integer >= 0, weight >= 0}`)
      })
    }
    c.problems.push(...g.problems)
  })
  return c.problems
}

const CHECKS: Partial<Record<ContentKind, (v: unknown, where: string) => Problems>> = {
  mobs: checkMobDef,
  nests: checkNestDef,
  items: checkItemDef,
  drops: checkDropTable,
  levels: checkLevelDef,
  npcs: checkNpcDef,
  cos: checkCosDef,
}

/**
 * Checks every entry of a parsed content file (ContentFile wrapper, or a bare array for levels.json).
 * Kinds without a checker (skills, masteries, npcs, shops) only get the wrapper check.
 */
export function checkContentFile(kind: ContentKind, json: unknown): Problems {
  let entries: unknown[]
  try {
    entries = contentEntries<unknown>(json, Array.isArray(json) ? undefined : kind)
  } catch (e) {
    return [`${CONTENT_FILES[kind]}: ${(e as Error).message}`]
  }
  const check = CHECKS[kind]
  if (!check) return []
  return entries.flatMap((e, i) => check(e, `${CONTENT_FILES[kind]}[${i}]`))
}
