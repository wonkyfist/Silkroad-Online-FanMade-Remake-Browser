import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  UNIQUES_FILE,
  checkUniquesFile,
  mulberry32,
  type DropEntry,
  type GameplayRequest,
  type ItemDef,
  type MobDef,
  type NestDef,
  type Range,
  type ServerMessage,
  type UniqueDef,
  type UniqueDropGroup,
  type UniqueDropTable,
  type UniqueGearPool,
  type UniquesFile,
} from '@sro/shared'
import { knob } from './config.ts'
import type { UniqueRow } from './db.ts'
import { goldCode, type Gameplay, type RolledDrop } from './gameplay.ts'
import type { GmResult } from './gm.ts'
import type { SummonPolicy } from './mob-skills.ts'
import type { GameplayModule, KillOwner } from './modules.ts'
import type { NavPoint } from './nav.ts'
import type { Mob, Player } from './world.ts'

/**
 * Unique monsters as world bosses (docs/UNIQUES.md §3; docs/WAVE_PLAN7.md §2.2, §3.4; lane U-S). A GameplayModule named
 * `uniques`, registered last, only when UNIQUES=on (`Gameplay.uniques` is null otherwise and the Spawner keeps the unique
 * groups as plain nests: the wave-10 behaviour).
 *
 * - **Content:** CONTENT_DIR/uniques.json (content.ts UniquesFile), checked at start with checkUniquesFile against the
 *   loaded mobs, nests and items; any problem, an unknown mob or a unique without camps fails the server start. A unique
 *   of another world is ignored; no CONTENT_DIR (tests) or no file = no uniques.
 * - **Spawn rules (§3.2):** at most one alive per unique. Its camps are re-read from `data.nests` at every roll (so the
 *   GM spawn editor, `/nest` and `content reload nests` apply: a disabled or removed camp drops out); the roll is
 *   uniform over the camps that place on the navmesh (`Gameplay.nestSpawnPoint`; a camp that will not place is skipped
 *   and logged; none places: retry in a minute). Timers live in the `uniques` table (migration 10), written on spawn,
 *   death, GM changes and at start: a fresh database rolls the first spawn `firstSpawnMin` after the boot; a restart
 *   keeps a waiting row's due time (a due time passed during the downtime, or a row that was alive: `restartSpawnMin`
 *   after the boot, at a new camp, at full HP); a kill or a GM despawn rolls `respawnMin`.
 * - **Notices (§3.3):** `uniqueNotice` to every world socket (`world.players`; never the lobby), except GMs who typed
 *   `/unique quiet on`. Appear: the zone name at the spawn point (GameData.zoneName, printed as is). Defeat: the
 *   loot-owner group (KillOwner, from Gameplay.mobDied before its damage map is cleared), named by its top-damage member,
 *   `party: true` for a party. A GM kill or despawn (`/unique kill|despawn`, or the generic `/kill`, which runs no hook
 *   and is noticed here in `tick`) is silent and runs the respawn timer.
 * - **Behaviour (§3.6):** the camp's tactics (sight 14 m, leash 50 m from the camp, roam and spawn within 40 m:
 *   uniqueHome, through createMob's nest); the
 *   `tuning` multipliers through createMob's MobTuning; summons through `summonPolicy` (the rows' own 80/60/40 % bands,
 *   clipped per wave, capped, normal variants only); enrage at `enrage.hpPct` once per fight and the fury `fury.afterSec`
 *   after the first damage since the last reset, both through `Mob.damageMul` (multiplied together), each with a system
 *   line to the players within 60 m. A leash reset (the AI's `return`, or back home idle with an empty damage map) sends
 *   her adds away (MobSkills.dismissSummons), clears the fight clock, the enrage and the fury; the AI refills her HP at
 *   home and MobSkills re-arms the bands there.
 * - **Loot (§3.4):** `drops` replaces the field unique's whole loot with its own table (gold piles, gear pools resolved
 *   from items.json at start with `reqLevel` <= LEVEL_CAP, plus levels by weight); GOLD_RATE and DROP_RATE apply as to
 *   any table. The quest encounter's Tiger Girl and a GM `spawn` of her code are plain mobs: not tracked, normal loot.
 * - **Corpse:** `Mob.corpseMs` = `corpseSec` (8 s), so her death clip plays to the ground.
 * - **GM:** `/unique list | spawn | kill | despawn | timer | quiet` (gm.ts row; audited like every GM command).
 */

/** The GM usage line (gm.ts COMMANDS.unique). */
export const UNIQUE_USAGE = 'unique list | spawn <name> [here | camp <id>] | kill <name> | despawn <name> | timer <name> <minutes|now|clear> | quiet <on|off>'

/** Players within this many metres of her get the enrage and fury lines (docs/UNIQUES.md §3.6). */
export const UNIQUE_AREA_LINE_M = 60
/** An attacker this far past her leash (m, from her home) leaves her damage map (H11-FURY-2). */
export const UNIQUE_FIGHT_MARGIN_M = 40
/** No camp places on the navmesh: try again after this long (ms). */
export const UNIQUE_RETRY_MS = 60_000

const MINUTE_MS = 60_000
/** Equipment categories of a gear pool (weapons, shields, armour of both sexes, accessories). */
const GEAR_CATEGORIES: ReadonlySet<string> = new Set(['weapon', 'shield', 'armor', 'accessory'])
/** `<family>_<grade>[_RARE]`; the creation defaults (`_DEF`) never match. */
const GRADE_RE = /^(.+)_([A-Z])(_RARE)?$/

/** A gear family (one item in its grades), the wearable grades only, highest grade first. */
export interface GearFamily {
  base: string
  grades: ItemDef[]
}

/** A unique drop group with its gear pool resolved. */
export interface ResolvedDropGroup extends Omit<UniqueDropGroup, 'pool'> {
  pool?: GearFamily[]
  gradeWeights?: number[]
}

export interface ResolvedDropTable {
  gold?: UniqueDropTable['gold']
  groups: ResolvedDropGroup[]
}

/**
 * The families of a gear pool rule (docs/UNIQUES.md §3.4): equipment of `pool.degree` (weapons, shields, armour,
 * accessories; not the European rows, not the `_DEF` creation defaults), the `_RARE` (Seal of Star) rows when
 * `pool.rare`, else the ordinary ones, whose `reqLevel` is at most `maxReqLevel` ('levelCap' = `levelCap`). A family
 * without a wearable grade is left out.
 */
export function gearPool(items: Iterable<ItemDef>, pool: UniqueGearPool, levelCap: number): GearFamily[] {
  const max = pool.maxReqLevel === 'levelCap' ? levelCap : pool.maxReqLevel
  const families = new Map<string, ItemDef[]>()
  for (const it of items) {
    if (!GEAR_CATEGORIES.has(it.category) || it.degree !== pool.degree || it.race === 'europe' || it.reqLevel > max) continue
    const m = GRADE_RE.exec(it.code)
    if (!m || Boolean(m[3]) !== Boolean(pool.rare)) continue
    // H11-NL-1: on a `_RARE` row the letter is the seal, not a grade (A = Star, B = Moon, C = Sun; items.json gives all
    // three the A grade's level). The rare pool is the Seal of Star rows only.
    if (pool.rare && m[2] !== 'A') continue
    const list = families.get(m[1]) ?? []
    list.push(it)
    families.set(m[1], list)
  }
  const grade = (it: ItemDef) => GRADE_RE.exec(it.code)![2]
  return [...families.entries()]
    .map(([base, grades]) => ({ base, grades: grades.sort((a, b) => grade(b).localeCompare(grade(a))) }))
    .sort((a, b) => a.base.localeCompare(b.base))
}

/** Resolves a unique drop table's gear pools against the item catalog (server start). */
export function resolveDropTable(t: UniqueDropTable, items: Iterable<ItemDef>, levelCap: number): ResolvedDropTable {
  const all = [...items]
  return {
    ...(t.gold ? { gold: t.gold } : {}),
    groups: t.groups.map((g) => {
      const { pool, ...rest } = g
      if (!pool) return rest
      // A rare family is its one Star row: gradeWeights (a grade split) do not apply to it.
      return { ...rest, pool: gearPool(all, pool, levelCap), ...(pool.rare ? {} : { gradeWeights: pool.gradeWeights }) }
    }),
  }
}

function pickWeighted<T>(list: readonly T[], weight: (x: T, i: number) => number, rng: () => number): T | undefined {
  const total = list.reduce((s, x, i) => s + Math.max(0, weight(x, i)), 0)
  if (total <= 0) return list[0]
  let r = rng() * total
  return list.find((x, i) => (r -= Math.max(0, weight(x, i))) < 0) ?? list[list.length - 1]
}

/**
 * Rolls a resolved unique drop table: `piles` gold drops, then every group `rolls` times (each with `chance`), one pick
 * by weight from `entries`, or a family uniformly from the gear pool and its grade by `gradeWeights` (highest wearable
 * grade first; a grade past the list weighs 0), plus a plus level by weight. `rates` as rollDrops (GOLD_RATE on the gold
 * amounts, DROP_RATE on every group's chance, at most 1).
 */
export function rollUniqueDrops(t: ResolvedDropTable, rng: () => number, known: (code: string) => boolean, rates: { gold?: number; drop?: number } = {}): RolledDrop[] {
  const out: RolledDrop[] = []
  if (t.gold && rng() < t.gold.chance) {
    const [lo, hi] = t.gold.amount
    for (let i = 0; i < t.gold.piles; i++) {
      const amount = Math.round(Math.round(lo + rng() * (hi - lo)) * (rates.gold ?? 1))
      if (amount > 0) out.push({ code: goldCode(amount), count: amount, gold: true })
    }
  }
  const dropRate = rates.drop ?? 1
  for (const g of t.groups) {
    for (let n = 0; n < (g.rolls ?? 1); n++) {
      if (rng() >= Math.min(1, g.chance * dropRate)) continue
      let code: string | undefined
      let count = 1
      if (g.pool) {
        if (g.pool.length === 0) continue
        const fam = g.pool[Math.min(g.pool.length - 1, Math.floor(rng() * g.pool.length))]
        const w = g.gradeWeights ?? [1]
        code = pickWeighted(fam.grades, (_x, i) => w[i] ?? 0, rng)?.code
      } else {
        const entries = (g.entries ?? []).filter((e: DropEntry) => e.weight > 0 && known(e.item))
        const pick = pickWeighted(entries, (e) => e.weight, rng)
        if (!pick) continue
        code = pick.item
        const [lo, hi] = pick.count ?? [1, 1]
        count = Math.max(1, Math.round(lo + rng() * (hi - lo)))
      }
      if (!code || !known(code)) continue
      const plus = g.plus ? (pickWeighted(g.plus, (p) => p.weight, rng)?.plus ?? 0) : 0
      out.push(plus > 0 ? { code, count, plus } : { code, count })
    }
  }
  return out
}

/** One unique on this world: its content, its saved row and its live fight. */
interface Tracked {
  def: UniqueDef
  mob: MobDef
  table: ResolvedDropTable
  row: UniqueRow
  /** The live mob's entity id while she is in the world (a corpse included until the death is handled). */
  id: number | null
  /** First damage since the last reset (ms); null = no fight. */
  fightAt: number | null
  enraged: boolean
  furious: boolean
  /** "no camp places" already logged for this streak. */
  stuck: boolean
  /** The due time a GM set with `/unique timer` this session (may lie past the window; the tick keeps it). */
  gmDue: number | null
}

/**
 * The nest a unique lives by: its camp with the roam and spawn circles clipped to `leashRange − 10` (her retail camps
 * roam 100 m and spawn within 60 m, but leash at 50 m: createMob's `max(leash, radius + 10)` would stretch the leash to
 * 110 m, and a wider roam would leash her on the first aggro). So she spawns and wanders within 40 m of the camp and
 * gives up 50 m from it (docs/UNIQUES.md §3.6).
 */
export function uniqueHome(camp: NestDef): NestDef {
  const cap = Math.max(5, camp.tactics.leashRange - 10)
  return { ...camp, radius: Math.min(camp.radius, cap), spawnRadius: Math.min(camp.spawnRadius, cap) }
}

/** h:mm of a duration in ms (rounded up to the minute; never negative). */
export function hmm(ms: number): string {
  const min = Math.max(0, Math.ceil(ms / MINUTE_MS))
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`
}

export class Uniques implements GameplayModule {
  readonly name = 'uniques'
  readonly handles: readonly GameplayRequest[] = []
  /**
   * The module's own random stream (timers, camp rolls, loot), so loading it never shifts the gameplay stream other
   * systems roll from: a fixed seed when the config passes a seeded `rng` (tests), else Math.random. Tests may replace it.
   */
  rng: () => number
  /** Every unique of this world, in file order. */
  private list: Tracked[] = []
  /** Player entity ids whose GM typed `/unique quiet on` (this session only; dropped when the player leaves). */
  private readonly quiet = new Set<number>()
  private upsert: ((row: UniqueRow) => void) | null = null

  constructor(readonly g: Gameplay) {
    this.rng = g.config.rng ? mulberry32(0x0711e5) : Math.random
  }

  /** The uniques of this world (read-only views, for tests and `/unique list`). */
  get uniques(): readonly { def: UniqueDef; row: Readonly<UniqueRow>; id: number | null }[] {
    return this.list
  }

  // ---- start ----------------------------------------------------------------------------------------------

  /**
   * Server start (after the nests are filled): reads and checks uniques.json, loads the saved rows and applies the
   * restart rules. Returns a log line, or null without a CONTENT_DIR. Throws on a bad file (the server does not start).
   */
  start(now: number): string | null {
    const dir = this.g.config.contentDir
    if (!dir) return null
    const path = join(dir, UNIQUES_FILE)
    if (!existsSync(path)) return `uniques: no ${UNIQUES_FILE} in ${dir} (no world bosses)`
    let json: unknown
    try {
      json = JSON.parse(readFileSync(path, 'utf8'))
    } catch (e) {
      throw new Error(`${UNIQUES_FILE}: ${(e as Error).message}`)
    }
    return this.configure(json, now)
  }

  /** start() on an already parsed file (tests). */
  configure(json: unknown, now: number): string {
    const { data, config } = this.g
    const problems = checkUniquesFile(json, { mob: (c) => data.mob(c) !== undefined, nest: (id) => data.nests.some((n) => n.id === id), item: (c) => data.items.has(c) })
    if (problems.length) throw new Error(`${UNIQUES_FILE}: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`)
    const file = json as UniquesFile
    this.prepare()
    this.list = []
    const lines: string[] = []
    for (const def of file.uniques) {
      if (def.world !== config.world) continue
      const mob = data.mob(def.mob)!
      if (config.mobLevelMax > 0 && mob.level > config.mobLevelMax) {
        lines.push(`${mob.name ?? mob.code} off (level ${mob.level} > MOB_LEVEL_MAX ${config.mobLevelMax})`)
        continue
      }
      if (this.allCamps(def).length === 0) throw new Error(`${UNIQUES_FILE}: ${def.mob} has no camps in nests.json on world ${config.world}`)
      const table = resolveDropTable(file.dropTables[def.drops], data.items.values(), config.levelCap)
      for (const [i, grp] of table.groups.entries()) {
        if (grp.pool && grp.pool.length === 0) config.log(`uniques: ${def.drops}.groups[${i}]: no item of its gear pool is in items.json and wearable at level ${config.levelCap}; the group drops nothing`)
      }
      const u: Tracked = { def, mob, table, row: this.loadRow(def.mob), id: null, fightAt: null, enraged: false, furious: false, stuck: false, gmDue: null }
      lines.push(this.restart(u, now))
      this.list.push(u)
    }
    return `uniques: ${lines.length ? lines.join('; ') : `none on world ${config.world}`}`
  }

  /** The restart rules (§3.2) on a loaded (or fresh) row; saves it. Returns the log fragment. */
  private restart(u: Tracked, now: number): string {
    const r = u.row
    const name = u.mob.name ?? u.mob.code
    let why: string
    if (r.spawns === 0 && r.phase === 'waiting' && r.due_at === 0 && r.last_killed_at === null) {
      r.due_at = now + this.minutes(u.def.firstSpawnMin)
      why = 'first spawn'
    } else if (r.phase === 'alive') {
      r.phase = 'waiting'
      r.due_at = now + this.minutes(u.def.restartSpawnMin)
      why = 'was alive at shutdown'
    } else if (r.due_at <= now) {
      r.due_at = now + this.minutes(u.def.restartSpawnMin)
      why = 'overdue'
    } else if (r.due_at - now > this.windowMs(u)) {
      // H11-CU-2: a due time past every window she has was written by a clock that ran ahead (or a hand edit).
      r.due_at = now + this.minutes(u.def.respawnMin)
      why = 'due time beyond the window (clock change?); re-rolled'
    } else why = 'timer kept'
    this.save(u)
    return `${name} waiting, spawns in ${hmm(r.due_at - now)} (${why}; ${this.camps(u.def).length} camps)`
  }

  private prepare(): void {
    if (this.upsert) return
    const db = this.g.store.db
    const st = db.prepare(
      `INSERT INTO uniques (code, phase, due_at, camp, spawns, last_killer, last_killed_at)
       VALUES (@code, @phase, @due_at, @camp, @spawns, @last_killer, @last_killed_at)
       ON CONFLICT(code) DO UPDATE SET phase = excluded.phase, due_at = excluded.due_at, camp = excluded.camp, spawns = excluded.spawns,
         last_killer = excluded.last_killer, last_killed_at = excluded.last_killed_at`,
    )
    this.upsert = (row) => void st.run({ ...row })
  }

  private loadRow(code: string): UniqueRow {
    const row = this.g.store.db.prepare('SELECT code, phase, due_at, camp, spawns, last_killer, last_killed_at FROM uniques WHERE code = ?').get(code) as UniqueRow | undefined
    if (row) return { ...row, phase: row.phase === 'alive' ? 'alive' : 'waiting' }
    return { code, phase: 'waiting', due_at: 0, camp: null, spawns: 0, last_killer: null, last_killed_at: null }
  }

  private save(u: Tracked): void {
    this.upsert?.(u.row)
  }

  /** The longest wait any of her rules can roll (ms): a waiting due time past it is a clock change. */
  private windowMs(u: Tracked): number {
    return Math.max(u.def.respawnMin[1], u.def.firstSpawnMin[1], u.def.restartSpawnMin[1]) * MINUTE_MS
  }

  /** Uniform in a [min, max] minutes range, in ms. */
  private minutes(r: Range): number {
    return Math.round((r[0] + this.rng() * (r[1] - r[0])) * MINUTE_MS)
  }

  // ---- camps ----------------------------------------------------------------------------------------------

  /** Every nest of the unique on this world (disabled ones included): the GM spawn's tactics template. */
  private allCamps(def: UniqueDef): NestDef[] {
    const world = this.g.config.world
    const ids = def.camps === 'uniqueGroup' ? null : new Set(def.camps)
    return this.g.data.nests.filter((n) => n.world === world && (ids ? ids.has(n.id) : n.uniqueGroup !== undefined && n.uniqueGroup !== '' && n.mob === def.mob))
  }

  /** The camps a roll may use now: re-read from data.nests (GM edits apply), enabled ones only. */
  camps(def: UniqueDef): NestDef[] {
    return this.allCamps(def).filter((n) => n.enabled !== false)
  }

  // ---- the scheduler --------------------------------------------------------------------------------------

  /** Once per server tick, after the mobs. */
  tick(now: number): void {
    for (const u of this.list) {
      if (u.id === null) {
        if (u.row.phase === 'waiting' && u.row.due_at > 0 && u.row.due_at !== u.gmDue && u.row.due_at - now > this.windowMs(u)) {
          // H11-CU-2: the wall clock stepped back after the roll; re-roll so she is never away longer than her window.
          u.row.due_at = now + this.minutes(u.def.respawnMin)
          this.save(u)
          this.g.config.log(`uniques: ${u.mob.name ?? u.mob.code} due time beyond the window (clock change?); re-rolled, spawns in ${hmm(u.row.due_at - now)}`)
        }
        if (u.row.phase === 'waiting' && u.row.due_at > 0 && now >= u.row.due_at && this.g.config.spawnMobs !== false) this.roll(u, now)
        continue
      }
      const m = this.g.world.mobs.get(u.id)
      // Dead or gone without the mobDied hook: a GM `/kill`, or removed from the world. Silent; the timer runs.
      if (!m || m.ai === 'dead') {
        this.ended(u, now, null, m ? 'killed by a GM' : 'removed')
        continue
      }
      this.behave(u, m, now)
    }
  }

  /** A uniform roll over the camps that place (tried in a random order); none places: retry in a minute (not for a GM). */
  private roll(u: Tracked, now: number, gm = false): Mob | null {
    const camps = this.camps(u.def)
    for (let i = camps.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1))
      ;[camps[i], camps[j]] = [camps[j], camps[i]]
    }
    for (const camp of camps) {
      const home = uniqueHome(camp)
      const at = this.g.nestSpawnPoint(home)
      if (at) return this.spawn(u, home, at, now)
      this.g.config.log(`uniques: ${u.def.mob} camp ${camp.id} does not place on the navmesh; skipped`)
    }
    if (gm) return null
    u.row.due_at = now + UNIQUE_RETRY_MS
    this.save(u)
    if (!u.stuck) this.g.config.log(`uniques: ${u.def.mob}: no camp places (${camps.length} enabled); retrying every ${UNIQUE_RETRY_MS / 1000} s`)
    u.stuck = true
    return null
  }

  /** She appears at `at` with `camp`'s home and tactics; saved and announced. */
  private spawn(u: Tracked, camp: NestDef, at: NavPoint, now: number): Mob {
    const m = this.g.createMob(u.mob, 'unique', at.x, at.z, at.y, camp, now, at.surface, { ...u.def.tuning })
    m.corpseMs = u.def.corpseSec * 1000
    u.id = m.id
    u.fightAt = null
    u.enraged = u.furious = u.stuck = false
    u.row.phase = 'alive'
    u.row.due_at = 0
    u.row.camp = camp.id
    u.row.spawns++
    this.save(u)
    const area = this.areaAt(at.x, at.z)
    this.g.config.log(`uniques: ${m.name} appeared at camp ${camp.id}${area ? ` (${area})` : ''}, id ${m.id}, ${m.maxHp} HP`)
    if (u.def.announce.appear) {
      // H11-NL-5 (§3.3): the players within roarRadiusM of the spot also hear her roar once (the client plays it).
      // H11-DET-1: `at` stamps the server ms, so every client starts the town's alarm on the same second.
      const r = u.def.announce.roarRadiusM ?? 0
      const near = new Set(r > 0 ? this.g.world.playersNear(at.x, at.z, r, now).map((p) => p.id) : [])
      const msg = { t: 'uniqueNotice', event: 'appeared', mob: u.mob.code, name: m.name, ...(area ? { area } : {}), at: now } as const
      for (const p of this.g.world.players.values()) if (!this.quiet.has(p.id)) p.send(near.has(p.id) ? { ...msg, roar: true } : msg)
    }
    return m
  }

  /** Her life ended: a rewarded kill (`owner`, announced) or a GM kill / despawn (silent). The respawn timer runs. */
  private ended(u: Tracked, now: number, owner: KillOwner | null, how: string): void {
    const name = u.mob.name ?? u.mob.code
    u.id = null
    u.fightAt = null
    u.enraged = u.furious = false
    u.row.phase = 'waiting'
    u.row.due_at = now + this.minutes(u.def.respawnMin)
    if (owner) {
      u.row.last_killer = owner.player?.name ?? null
      u.row.last_killed_at = now
    }
    this.save(u)
    this.g.config.log(`uniques: ${name} ${how}; next spawn in ${hmm(u.row.due_at - now)}`)
    if (owner && u.def.announce.defeat) {
      const by = owner.player?.name
      this.notify({ t: 'uniqueNotice', event: 'defeated', mob: u.mob.code, name, ...(by ? { by } : {}), ...(by && owner.party !== null ? { party: true } : {}) })
    }
  }

  /** The fight: first damage starts the fury clock; enrage once; a leash reset clears everything. */
  private behave(u: Tracked, m: Mob, now: number): void {
    const dirty = u.fightAt !== null || u.enraged || u.furious
    if (m.ai === 'return' || (m.ai === 'idle' && m.damage.size === 0)) {
      if (dirty) this.reset(u, m)
      return
    }
    // H11-FURY-2: an attacker who left the world, or went well past her leash (UNIQUE_FIGHT_MARGIN_M: a ranged
    // attacker at the leash's edge keeps his share), is out of the fight: no kill share. With no attacker inside the
    // leash the fury clock stops (a sight-aggro chase or a far tag does not run it).
    let inLeash = 0
    const far2 = (m.leashRange + UNIQUE_FIGHT_MARGIN_M) ** 2
    for (const id of [...m.damage.keys()]) {
      const p = this.g.world.players.get(id)
      if (!p) {
        m.damage.delete(id)
        continue
      }
      const at = this.g.world.livePoint(p, now)
      const d2 = (at.x - m.home[0]) ** 2 + (at.z - m.home[1]) ** 2
      if (d2 > far2) m.damage.delete(id)
      else if (d2 <= m.leashRange ** 2) inLeash++
    }
    if (inLeash === 0) u.fightAt = null
    // A wall clock stepped back mid-fight: the clock restarts from now (never a negative fight time).
    if (u.fightAt !== null && u.fightAt > now) u.fightAt = now
    if (u.fightAt === null && inLeash > 0) u.fightAt = now
    if (!u.enraged && m.hp <= (m.maxHp * u.def.enrage.hpPct) / 100) {
      u.enraged = true
      this.applyMul(u, m)
      this.areaLine(m, now, `${m.name} is enraged!`)
    }
    if (!u.furious && u.fightAt !== null && now - u.fightAt >= u.def.fury.afterSec * 1000) {
      u.furious = true
      this.applyMul(u, m)
      this.areaLine(m, now, `${m.name} grows furious!`)
    }
  }

  /**
   * Gameplay.restored (the AI's arriveHome): a tracked unique got home after giving up, so her fight resets now
   * (H11-FURY-1), before anything later in the same tick (a projectile, a DoT) can put her back in a chase.
   */
  homeReached(m: Mob): void {
    const u = this.tracked(m)
    if (u && (u.fightAt !== null || u.enraged || u.furious)) this.reset(u, m)
  }

  /** A leash reset (§3.6): adds leave, the fight clock, enrage and fury clear (HP and bands: the AI and MobSkills). */
  private reset(u: Tracked, m: Mob): void {
    const adds = this.g.mobSkills.dismissSummons(m)
    u.fightAt = null
    u.enraged = u.furious = false
    this.applyMul(u, m)
    this.g.config.log(`uniques: ${m.name} reset (leash)${adds ? `; ${adds} adds left` : ''}`)
  }

  private applyMul(u: Tracked, m: Mob): void {
    const mul = (u.enraged ? u.def.enrage.damageMul : 1) * (u.furious ? u.def.fury.damageMul : 1)
    if (mul === 1) delete m.damageMul
    else m.damageMul = mul
  }

  private areaLine(m: Mob, now: number, text: string): void {
    const at = this.g.world.livePoint(m, now)
    for (const p of this.g.world.playersNear(at.x, at.z, UNIQUE_AREA_LINE_M, now)) p.send({ t: 'chat', channel: 'system', text })
  }

  /** `uniqueNotice` (or any message) to every player in the world but the quiet GMs. */
  private notify(msg: ServerMessage): void {
    for (const p of this.g.world.players.values()) if (!this.quiet.has(p.id)) p.send(msg)
  }

  /** The client's area name at x/z, '' where there is none. */
  private areaAt(x: number, z: number): string {
    return this.g.data.zoneName(x, z, this.g.setup.regionOrigin)
  }

  private tracked(m: Mob): Tracked | undefined {
    for (const u of this.list) if (u.id === m.id) return u
    return undefined
  }

  // ---- Gameplay seams -------------------------------------------------------------------------------------

  /** A rewarded kill (after rewards and loot): the defeat notice names the loot-owner group. */
  mobDied(m: Mob, now: number, _credit: ReadonlySet<number>, owner: KillOwner): void {
    const u = this.tracked(m)
    if (u) this.ended(u, now, owner, `defeated by ${owner.player?.name ?? 'nobody'}${owner.party !== null ? "'s party" : ''}`)
  }

  /** The field unique's whole loot (its own table); null for every other mob (the quest encounter included). */
  drops(m: Mob, _now: number): RolledDrop[] | null {
    const u = this.tracked(m)
    if (!u) return null
    const { config, data } = this.g
    const drops = rollUniqueDrops(u.table, this.rng, (c) => data.items.has(c), { gold: config.goldRate, drop: config.dropRate })
    // H11-NL-8: never above the plus this server lets anyone reach (ALCHEMY_MAX_PLUS).
    const max = knob(config, 'alchemyMaxPlus')
    for (const d of drops) if (d.plus !== undefined && d.plus > max) d.plus = max
    return drops
  }

  /** The field unique's summon switch, clip, cap and variants; null for every other mob. */
  summonPolicy(m: Mob): SummonPolicy | null {
    const u = this.tracked(m)
    if (!u) return null
    const s = u.def.summons
    return { on: s.on, perWave: s.perWave, maxAlive: s.maxAlive, variants: s.variants }
  }

  /** The player leaves the world: a quiet flag ends with the session. */
  forget(p: Player): void {
    this.quiet.delete(p.id)
  }

  /** Whether a unique is alive now, and where (the quest hook's fact, docs/UNIQUES.md §3.10). */
  alive(code: string): { id: number; name: string; area: string } | null {
    const u = this.list.find((x) => x.def.mob === code)
    const m = u && u.id !== null ? this.g.world.mobs.get(u.id) : undefined
    if (!m || m.ai === 'dead') return null
    const at = this.g.world.livePoint(m, this.g.now)
    return { id: m.id, name: m.name, area: this.areaAt(at.x, at.z) }
  }

  // ---- GM -------------------------------------------------------------------------------------------------

  /** `/unique ...` (gm.ts). `self` is the GM's character (null from the lobby). */
  gm(self: Player | null, args: string[], now = this.g.now): GmResult {
    const fail = (message: string): GmResult => ({ ok: false, message })
    const sub = (args[0] ?? '').toLowerCase()
    const rest = args.slice(1).join(' ').trim().split(/\s+/).filter(Boolean)
    if (sub === 'list' && rest.length === 0) return this.gmList(now)
    if (sub === 'quiet') {
      const v = (rest[0] ?? '').toLowerCase()
      if (rest.length !== 1 || (v !== 'on' && v !== 'off')) return fail(`Usage: ${UNIQUE_USAGE}`)
      if (!self) return fail('unique quiet needs your character in the world.')
      if (v === 'on') this.quiet.add(self.id)
      else this.quiet.delete(self.id)
      return { ok: true, message: v === 'on' ? 'Unique notices are hidden from you until you leave the world.' : 'Unique notices are shown to you again.', data: { quiet: v === 'on' } }
    }
    if (sub === 'spawn') {
      let where: { kind: 'roll' } | { kind: 'here' } | { kind: 'camp'; id: number } = { kind: 'roll' }
      const words = [...rest]
      if (words.at(-1)?.toLowerCase() === 'here') {
        words.pop()
        where = { kind: 'here' }
      } else if (words.length >= 2 && words.at(-2)!.toLowerCase() === 'camp') {
        const id = Number(words.pop())
        words.pop()
        if (!Number.isInteger(id)) return fail(`Usage: ${UNIQUE_USAGE}`)
        where = { kind: 'camp', id }
      }
      const u = this.find(words.join(' '))
      if (typeof u === 'string') return fail(u)
      return this.gmSpawn(u, where, self, now)
    }
    if (sub === 'kill' || sub === 'despawn') {
      const u = this.find(rest.join(' '))
      if (typeof u === 'string') return fail(u)
      const m = u.id === null ? undefined : this.g.world.mobs.get(u.id)
      if (!m || m.ai === 'dead') return fail(`${u.mob.name ?? u.mob.code} is not alive (${this.waitingText(u, now)}).`)
      if (sub === 'kill') this.g.gmKill(m, now)
      else this.g.world.removeEntity(m.id)
      this.ended(u, now, null, sub === 'kill' ? 'killed by a GM (/unique kill)' : 'despawned by a GM')
      return { ok: true, message: `${m.name} ${sub === 'kill' ? 'killed' : 'despawned'} (not announced); next spawn in ${hmm(u.row.due_at - now)}.`, data: { id: m.id, dueAt: u.row.due_at } }
    }
    if (sub === 'timer') {
      if (rest.length < 2) return fail(`Usage: ${UNIQUE_USAGE}`)
      const v = rest[rest.length - 1].toLowerCase()
      const u = this.find(rest.slice(0, -1).join(' '))
      if (typeof u === 'string') return fail(u)
      const name = u.mob.name ?? u.mob.code
      if (u.id !== null) return fail(`${name} is alive; kill or despawn her first.`)
      const min = Number(v)
      if (v === 'now') u.row.due_at = now
      else if (v === 'clear') u.row.due_at = now + this.minutes(u.def.respawnMin)
      else if (v !== '' && Number.isFinite(min) && min >= 0 && min <= 7 * 24 * 60) u.row.due_at = now + Math.round(min * MINUTE_MS)
      else return fail(`Usage: ${UNIQUE_USAGE}`)
      u.row.phase = 'waiting'
      u.stuck = false
      u.gmDue = u.row.due_at
      this.save(u)
      return { ok: true, message: `${name} spawns in ${hmm(u.row.due_at - now)}.`, data: { dueAt: u.row.due_at } }
    }
    return fail(`Usage: ${UNIQUE_USAGE}`)
  }

  /** The unique a GM means: a code or name (exact, else a unique part of one); a string is the error. */
  private find(q: string): Tracked | string {
    const s = q.trim().toLowerCase()
    if (!s) return `Usage: ${UNIQUE_USAGE}`
    if (this.list.length === 0) return 'No uniques on this world.'
    const exact = this.list.filter((u) => u.mob.code.toLowerCase() === s || (u.mob.name ?? '').toLowerCase() === s)
    if (exact.length === 1) return exact[0]
    const part = this.list.filter((u) => u.mob.code.toLowerCase().includes(s) || (u.mob.name ?? '').toLowerCase().includes(s))
    if (part.length === 1) return part[0]
    const names = this.list.map((u) => u.mob.name ?? u.mob.code).join(', ')
    return part.length === 0 ? `No unique matches "${q.trim()}". Uniques: ${names}.` : `"${q.trim()}" matches several: ${part.map((u) => u.mob.name ?? u.mob.code).join(', ')}.`
  }

  private gmSpawn(u: Tracked, where: { kind: 'roll' } | { kind: 'here' } | { kind: 'camp'; id: number }, self: Player | null, now: number): GmResult {
    const fail = (message: string): GmResult => ({ ok: false, message })
    const name = u.mob.name ?? u.mob.code
    if (u.id !== null) {
      const m = this.g.world.mobs.get(u.id)
      if (m && m.ai !== 'dead') return fail(`${name} is already alive (id ${m.id}, camp ${u.row.camp}). One at a time.`)
    }
    let m: Mob | null
    if (where.kind === 'roll') {
      m = this.roll(u, now, true)
      if (!m) return fail(`No camp of ${name} places on the navmesh (${this.camps(u.def).length} enabled).`)
    } else if (where.kind === 'camp') {
      const camp = this.camps(u.def).find((n) => n.id === where.id)
      if (!camp) return fail(`Camp ${where.id} is not an enabled camp of ${name}. Camps: ${this.camps(u.def).map((n) => n.id).join(', ') || 'none'}.`)
      const home = uniqueHome(camp)
      const at = this.g.nestSpawnPoint(home)
      if (!at) return fail(`Camp ${where.id} does not place on the navmesh.`)
      m = this.spawn(u, home, at, now)
    } else {
      if (!self) return fail('unique spawn here needs your character in the world.')
      const template = this.camps(u.def)[0] ?? this.allCamps(u.def)[0]
      if (!template) return fail(`${name} has no camp in nests.json to take her tactics from.`)
      const at = this.g.world.livePoint(self, now)
      // Her home is the GM's spot (the leash counts from there), with the camps' tactics and id.
      m = this.spawn(u, uniqueHome({ ...template, x: at.x, z: at.z, y: at.y }), at, now)
    }
    const area = this.areaAt(m.pos[0], m.pos[2])
    return { ok: true, message: `${m.name} appeared (id ${m.id}, camp ${u.row.camp}${where.kind === 'here' ? ', at your position' : ''}${area ? `, ${area}` : ''}); announced.`, data: { id: m.id, camp: u.row.camp } }
  }

  private waitingText(u: Tracked, now: number): string {
    const r = u.row
    const due = r.due_at > 0 ? `spawns in ${hmm(r.due_at - now)}` : 'not scheduled'
    const last = r.last_killed_at !== null ? `; last killed${r.last_killer ? ` by ${r.last_killer}` : ''} ${hmm(now - r.last_killed_at)} ago` : ''
    return `waiting, ${due}${last}`
  }

  private gmList(now: number): GmResult {
    if (this.list.length === 0) return { ok: true, message: 'No uniques on this world.', data: { uniques: [] } }
    const lines: string[] = []
    const rows: unknown[] = []
    for (const u of this.list) {
      const name = `${u.mob.name ?? u.mob.code} (${u.mob.code})`
      const m = u.id === null ? undefined : this.g.world.mobs.get(u.id)
      if (m && m.ai !== 'dead') {
        const at = this.g.world.livePoint(m, now)
        const area = this.areaAt(at.x, at.z)
        const hp = Math.round((100 * m.hp) / m.maxHp)
        const fight = u.fightAt === null ? 'not fighting' : `fighting ${hmm(now - u.fightAt)} with ${m.damage.size} attacker${m.damage.size === 1 ? '' : 's'}`
        const flags = [u.enraged ? 'enraged' : '', u.furious ? 'furious' : ''].filter(Boolean)
        lines.push(`${name}: alive (id ${m.id}) at camp ${u.row.camp}${area ? ` (${area})` : ''}, HP ${hp}%, ${fight}${flags.length ? ` [${flags.join(', ')}]` : ''}`)
        rows.push({ code: u.mob.code, phase: 'alive', id: m.id, camp: u.row.camp, area, hpPct: hp, attackers: m.damage.size, fightMs: u.fightAt === null ? 0 : now - u.fightAt, enraged: u.enraged, furious: u.furious })
      } else {
        lines.push(`${name}: ${this.waitingText(u, now)} (${this.camps(u.def).length} camps)`)
        rows.push({ code: u.mob.code, phase: 'waiting', dueAt: u.row.due_at, lastKiller: u.row.last_killer, lastKilledAt: u.row.last_killed_at, spawns: u.row.spawns })
      }
    }
    return { ok: true, message: lines.join('\n'), data: { uniques: rows } }
  }
}
