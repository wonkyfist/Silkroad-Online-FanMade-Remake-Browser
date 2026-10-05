import type { MobDef, NestDef } from '@sro/shared'

/**
 * Nest spawner: keeps `count` mobs alive per enabled nest (docs/PROTOCOL.md §2; nests.json from the vSRO
 * server's Tab_RefNest via the third-party port). A mob that dies is replaced after a random delay in the nest's
 * `respawnSec` range, counted from its death. Nests sharing a `uniqueGroup` (unique monsters, e.g. Tiger Girl's
 * 11 candidate nests) hold ONE mob between them: it spawns at a random nest of the group, and after its death
 * the replacement is scheduled at a random nest of the group. With `skipUniqueGroups` (UNIQUES=on, wave 11) those
 * nests are refused instead (the uniques module owns them; docs/UNIQUES.md §3.2). Pure bookkeeping: the caller creates
 * and removes the entities.
 */

export interface NestRuntime {
  def: NestDef
  mob: MobDef
  /** Entity ids of this nest's living (or corpse) mobs. */
  alive: Set<number>
  /** Times (ms) at which a replacement is due. */
  pending: number[]
  /** NestDef.uniqueGroup: the group's nests share ONE living mob (see Spawner). */
  group?: string
}

export interface SpawnerOptions {
  /** World name; nests of other worlds are ignored. */
  world: string
  /** Nests whose mob is above this level stay empty (0 = no limit). */
  mobLevelMax: number
  rng: () => number
  /** NEST_COUNT_SCALE: every nest holds max(1, round(count x scale)) mobs (default 1; docs/FIELDS.md §4.2). */
  countScale?: number
  /**
   * Refuse every nest with a `uniqueGroup` (UNIQUES=on; docs/UNIQUES.md §3.2, WAVE_PLAN7 §4.2): the uniques module
   * spawns those mobs. Checked in `refusal`, so `updateNest` (the GM `/nest` edit, `content reload nests`) never
   * re-attaches one either. Absent / false = the wave-10 behaviour.
   */
  skipUniqueGroups?: boolean
  /**
   * A live multiplier of a plain nest's count on top of countScale (storms, docs/WEATHER.md §12.3: water spirits rise,
   * small animals hide, the big cats hunt in bigger packs). Absent = 1. Unique groups ignore it. The caller fills or
   * thins the nests when it changes (storm/service.ts); a due respawn beyond the count is dropped.
   */
  countMul?: (nest: NestRuntime) => number
}

/** Spawner.refusal's reason for a unique group's nest while the uniques module owns it. */
export const UNIQUE_GROUP_REFUSAL = 'unique group (uniques module)'

export interface NestSkip {
  nest: number
  reason: string
}

export class Spawner {
  readonly nests: NestRuntime[] = []
  readonly skipped: NestSkip[] = []
  private readonly byMob = new Map<number, NestRuntime>()
  /** uniqueGroup -> its nests. */
  private readonly groups = new Map<string, NestRuntime[]>()

  constructor(
    defs: readonly NestDef[],
    private readonly mobs: (code: string) => MobDef | undefined,
    readonly opts: SpawnerOptions,
    /** Whether a nest lies in the playable world (bounds; navmesh: open ground near its centre). */
    private readonly inWorld: (x: number, z: number, def: NestDef) => boolean = () => true,
  ) {
    for (const def of defs) {
      const mob = mobs(def.mob)
      const reason = this.refusal(def, mob)
      if (reason !== null) this.skipped.push({ nest: def.id, reason })
      else this.attach(def, mob!)
    }
  }

  /** Why `def` cannot hold mobs here, or null when it can. */
  refusal(def: NestDef, mob: MobDef | undefined = this.mobs(def.mob)): string | null {
    if (def.enabled === false) return 'disabled'
    if (def.world !== this.opts.world) return `world ${def.world}`
    if (!mob) return `unknown mob ${def.mob}`
    if (this.opts.skipUniqueGroups && def.uniqueGroup) return UNIQUE_GROUP_REFUSAL
    if (this.opts.mobLevelMax > 0 && mob.level > this.opts.mobLevelMax) return `level ${mob.level} > ${this.opts.mobLevelMax}`
    if (!this.inWorld(def.x, def.z, def)) return 'outside the world'
    return null
  }

  private attach(def: NestDef, mob: MobDef): NestRuntime {
    const nest: NestRuntime = { def, mob, alive: new Set(), pending: [] }
    if (def.uniqueGroup) {
      nest.group = def.uniqueGroup
      this.groups.set(def.uniqueGroup, [...(this.groups.get(def.uniqueGroup) ?? []), nest])
    }
    this.nests.push(nest)
    return nest
  }

  private detach(nest: NestRuntime): void {
    const i = this.nests.indexOf(nest)
    if (i >= 0) this.nests.splice(i, 1)
    if (nest.group) {
      const rest = (this.groups.get(nest.group) ?? []).filter((n) => n !== nest)
      if (rest.length > 0) this.groups.set(nest.group, rest)
      else this.groups.delete(nest.group)
      // The group's one pending respawn moves to a nest that stays.
      if (rest.length > 0 && nest.pending.length > 0) rest[0].pending.push(...nest.pending)
    }
    for (const id of nest.alive) this.byMob.delete(id)
  }

  /** The live nest with id `id`, if it spawns. */
  nest(id: number): NestRuntime | undefined {
    return this.nests.find((n) => n.def.id === id)
  }

  // ---- GM content editors (docs/QUESTS.md §5.2; lane ED-S). Bookkeeping only: the caller despawns and fills. ----

  /**
   * `def` replaces nest `id` at runtime (a new nest, a patch, or null to take it out). Returns the live nest (null when it
   * does not spawn, with the refusal `reason`) and the entity ids the caller must despawn: all of them when the nest leaves,
   * its mob or its centre changes; otherwise the extras beyond its (new) count, `dropOrder` putting the first to go first.
   * The caller then fills the nest (fillNest) for the difference.
   */
  updateNest(id: number, def: NestDef | null, dropOrder: (ids: number[]) => number[] = (ids) => ids): { nest: NestRuntime | null; despawn: number[]; reason?: string } {
    const cur = this.nest(id)
    const mob = def ? this.mobs(def.mob) : undefined
    const reason = def ? this.refusal(def, mob) : 'removed'
    this.skipped.splice(0, this.skipped.length, ...this.skipped.filter((s) => s.nest !== id))
    if (reason !== null) {
      if (def) this.skipped.push({ nest: id, reason })
      if (!cur) return { nest: null, despawn: [], reason }
      const despawn = [...cur.alive]
      this.detach(cur)
      return { nest: null, despawn, reason }
    }
    if (!cur) return { nest: this.attach(def!, mob!), despawn: [] }
    const moved = cur.def.mob !== def!.mob || cur.def.x !== def!.x || cur.def.z !== def!.z
    cur.def = def!
    cur.mob = mob!
    if (moved) {
      const despawn = [...cur.alive]
      for (const m of despawn) this.byMob.delete(m)
      cur.alive.clear()
      cur.pending = []
      return { nest: cur, despawn }
    }
    let extra = cur.alive.size + cur.pending.length - this.want(cur)
    if (extra <= 0) return { nest: cur, despawn: [] }
    // Pending respawns go first (latest first), then living mobs in the caller's order.
    cur.pending.sort((a, b) => a - b)
    while (extra > 0 && cur.pending.length > 0) {
      cur.pending.pop()
      extra--
    }
    const despawn = dropOrder([...cur.alive]).slice(0, extra)
    for (const m of despawn) {
      cur.alive.delete(m)
      this.byMob.delete(m)
    }
    return { nest: cur, despawn }
  }

  /** Spawns the mobs `nest` is missing right now (GM editors). */
  fillNest(nest: NestRuntime, spawn: (nest: NestRuntime) => number | null): number {
    if (!this.nests.includes(nest)) return 0
    const at = nest.group ? this.pick(nest) : nest
    let n = 0
    while (at.alive.size + at.pending.length < this.want(at)) {
      const id = spawn(at)
      if (id === null) break
      this.track(at, id)
      n++
    }
    return n
  }

  /** Forgets a mob the caller removed from the world without a death (no replacement is scheduled). */
  forget(id: number): void {
    const nest = this.byMob.get(id)
    if (!nest) return
    nest.alive.delete(id)
    this.byMob.delete(id)
  }

  /** How many mobs `nest` may hold right now (with the live count multiplier). */
  wanted(nest: NestRuntime): number {
    return this.want(nest)
  }

  /** How many mobs a nest may hold right now (0 for a group nest while another nest of its group is taken). */
  private want(nest: NestRuntime): number {
    if (!nest.group) return this.count(nest)
    const busy = this.groups.get(nest.group)!.some((n) => n !== nest && n.alive.size + n.pending.length > 0)
    return busy ? 0 : 1
  }

  /** A plain nest's monster count after NEST_COUNT_SCALE. */
  private count(nest: NestRuntime): number {
    const scale = (this.opts.countScale ?? 1) * (nest.group ? 1 : (this.opts.countMul?.(nest) ?? 1))
    return scale === 1 ? nest.def.count : Math.max(1, Math.round(nest.def.count * scale))
  }

  /** A random nest of `nest`'s unique group (itself when it has none). */
  private pick(nest: NestRuntime): NestRuntime {
    const list = nest.group ? this.groups.get(nest.group)! : [nest]
    return list[Math.min(list.length - 1, Math.floor(this.opts.rng() * list.length))]
  }

  /** Mobs the nests want alive in total. */
  get capacity(): number {
    return this.nests.reduce((n, r) => n + (r.group ? 0 : this.count(r)), 0) + this.groups.size
  }

  /** Fills every nest at once (server start). `spawn` returns the new entity id, or null if it could not. */
  fill(spawn: (nest: NestRuntime) => number | null): number {
    let n = 0
    for (const first of this.nests) {
      // a unique group spawns once, at a random nest of the group
      const nest = first.group ? this.pick(first) : first
      while (nest.alive.size + nest.pending.length < this.want(nest)) {
        const id = spawn(nest)
        if (id === null) break
        this.track(nest, id)
        n++
      }
    }
    return n
  }

  track(nest: NestRuntime, id: number): void {
    nest.alive.add(id)
    this.byMob.set(id, nest)
  }

  /** A nest mob died at `now`: schedule its replacement. Returns the due time, or null for non-nest mobs. */
  died(id: number, now: number): number | null {
    const nest = this.byMob.get(id)
    if (!nest || !nest.alive.has(id)) return null
    nest.alive.delete(id)
    this.byMob.delete(id)
    const [lo, hi] = nest.def.respawnSec
    const due = now + (lo + this.opts.rng() * Math.max(0, hi - lo)) * 1000
    this.pick(nest).pending.push(due)
    return due
  }

  /** Spawns the replacements that are due. */
  tick(now: number, spawn: (nest: NestRuntime) => number | null): number {
    let n = 0
    for (const nest of this.nests) {
      if (nest.pending.length === 0) continue
      const due = nest.pending.filter((t) => t <= now)
      if (due.length === 0) continue
      nest.pending = nest.pending.filter((t) => t > now)
      for (let i = 0; i < due.length; i++) {
        // a plain nest already at its (live) count drops the respawn (storms thin some nests out)
        if (!nest.group && nest.alive.size >= this.count(nest)) continue
        const id = spawn(nest)
        if (id === null) {
          nest.pending.push(now + 5000)
          continue
        }
        this.track(nest, id)
        n++
      }
    }
    return n
  }
}
