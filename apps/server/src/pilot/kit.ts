import { PILOT_TAUNT_LINES, yawTowards, type ClientMessage, type PilotAbilityDef, type PilotDef, type PilotKitView, type SkillDef } from '@sro/shared'
import { fail, type Fail } from '../inventory.ts'
import type { Mob, Player } from '../world.ts'
import type { Pilot } from './service.ts'
import { clampToArea } from './steer.ts'
import { ACT_GAP_MS, CLAW_CHASE_M, PENDING_MS, PILOT_SKILL_PREFIX, QUEUE_MS, REPLAN_MS, ROAR_PUSH_SPEED, WALK_IN_M, type KitEntry, type Turn } from './types.ts'

/**
 * Play the Boss, the kit (docs/PLAY_THE_BOSS.md §3.2 acting, §3.5 the kit). Her retail rows (Claw, Sweep, Curse) run
 * through MobSkills.use unchanged (cast timing, release slack, statuses, cooldowns), so they land exactly as the AI's.
 * The new abilities are server-built: they send `cast {skill: PILOT_<NAME>_<ID>, clip}` and their hits reuse a retail
 * row's roll (MobSkills.rollHits) and Gameplay.dealHits, so the damage, combat messages and hit effects are today's.
 *
 * - Pounce (`leap`): to a hunter or a ground point within `rangeM`, a straight navmesh walk at `speedMs` (stops at walls,
 *   clamped to the hunt circle); on landing `hit.row`'s roll × `hit.mul` on the hunters within `hit.radiusM`, plus the
 *   status (knockdown).
 * - Fear Roar (`fear`): hunters within `radiusM` are knocked back (the existing status, 1 s, blocks) and pushed `pushM`
 *   away along a straight walk; the module's gate refuses their moveTo, attack and useSkill for `lockMs` (cant_act).
 * - Call the Pack (`pack`): `count` mobs beside her attacking her target (or the nearest hunter), adopted into her
 *   summons; `charges` uses per turn.
 * - Stalk (`stalk`): Mob.veil (interest hides her past `revealM` from hunters) and her speed × `speedMul`; ends on any
 *   act, any damage taken, after `maxMs`, or on the AI's handover; the cooldown counts from the end.
 */

/** The cast id of a server-built ability: PILOT_<mob code without MOB_ and the region>_<ID>, e.g. PILOT_TIGERWOMAN_POUNCE. */
export function castIdOf(code: string, id: string): string {
  const short = code.replace(/^MOB_/, '').replace(/^[A-Z]{2}_/, '')
  return `${PILOT_SKILL_PREFIX}${short}_${id.toUpperCase()}`
}

/** The kit of a `pilot` block against the skill book (unknown rows are left out, with a log line). */
export function resolveKit(code: string, def: PilotDef, row: (code: string) => SkillDef | undefined, log: (line: string) => void, mob: (code: string) => boolean = () => true): KitEntry[] {
  const out: KitEntry[] = []
  for (const a of def.kit) {
    const base = { def: a, id: a.id, slot: a.slot, castId: castIdOf(code, a.id) }
    if (!('kind' in a) || a.kind === undefined) {
      const r = row(a.row)
      if (!r) {
        log(`pilot: ${code} kit ${a.id}: no skill row ${a.row}; left out`)
        continue
      }
      out.push({ ...base, row: r, target: r.area?.shape === 'caster' ? 'none' : 'entity', rangeM: r.range, cooldownMs: r.cooldownMs, clip: '' })
      continue
    }
    switch (a.kind) {
      case 'leap': {
        const r = row(a.hit.row)
        if (!r) {
          log(`pilot: ${code} kit ${a.id}: no skill row ${a.hit.row}; left out`)
          continue
        }
        out.push({ ...base, row: r, target: 'point', rangeM: a.rangeM, cooldownMs: a.cooldownMs, clip: a.clip })
        break
      }
      case 'fear':
        out.push({ ...base, row: null, target: 'none', rangeM: a.radiusM, cooldownMs: a.cooldownMs, clip: a.clip })
        break
      case 'pack':
        if (!mob(a.mob)) {
          log(`pilot: ${code} kit ${a.id}: no mob ${a.mob}; left out`)
          continue
        }
        out.push({ ...base, row: null, target: 'none', rangeM: 0, cooldownMs: a.cooldownMs, charges: a.charges, clip: a.clip })
        break
      case 'stalk':
        out.push({ ...base, row: null, target: 'none', rangeM: a.revealM, cooldownMs: a.cooldownMs, clip: '' })
        break
    }
  }
  return out.sort((a, b) => a.slot - b.slot)
}

export function kitView(e: KitEntry): PilotKitView {
  const v: PilotKitView = { id: e.id, slot: e.slot, clip: e.clip, rangeM: e.rangeM, cooldownMs: e.cooldownMs, target: e.target }
  if (e.charges !== undefined) v.charges = e.charges
  return v
}

type Act = Extract<ClientMessage, { t: 'pilotAct' }>

export class Kit {
  private nextInstance = 1_900_000_000

  constructor(readonly s: Pilot) {}

  private get g() {
    return this.s.g
  }

  private instance(): number {
    const id = this.nextInstance
    this.nextInstance = id >= 1_990_000_000 ? 1_900_000_000 : id + 1
    return id
  }

  /** Busy: a cast or action window of a retail row, a server-built ability's window, or held (stun, knockdown). */
  busy(t: Turn, m: Mob, now: number): boolean {
    return this.g.mobSkills.busy(m, now) || now < t.busyUntil
  }

  /** When ability `e` is ready again (server ms; 0 = ready). */
  readyAt(t: Turn, m: Mob, e: KitEntry): number {
    if (e.row && !('kind' in e.def && e.def.kind)) return this.g.mobSkills.readyAt(m, e.row.code)
    return t.ready.get(e.id) ?? 0
  }

  /** A hunter the pilot may aim at: known to the pilot's client and attackable (§3.2). */
  hunter(pilot: Player, id: number): Player | Fail {
    if (!pilot.known.has(id)) return fail('not_found')
    const e = this.g.world.entity(id)
    if (!e) return fail('not_found')
    if (e.kind !== 'player') return fail('invalid_target', 'Only hunters can be attacked.')
    if (e.dead) return fail('target_dead')
    const q = this.g.target(id)
    return q ?? fail('invalid_target')
  }

  /** `pilotAct` (§3.2), checked in order; true = accepted (done now, or after a walk into reach). */
  act(t: Turn, m: Mob, pilot: Player, msg: Act, now: number): Fail | true {
    const e = t.conf.kit.find((k) => k.id === msg.ability)
    if (!e) return fail('not_found', `No ability ${msg.ability}.`)
    if (this.g.skills.held(m, now)) return fail('cant_act')
    // Stalk again ends it (any other act ends it too, below).
    if (e.def.kind === 'stalk' && t.stalk) {
      this.endStalk(t, m, now)
      return true
    }
    if (now - t.lastActAt < ACT_GAP_MS) return fail('busy')
    if (this.readyAt(t, m, e) > now) return fail('cooldown')
    if (e.charges !== undefined && (t.charges.get(e.id) ?? e.charges) <= 0) return fail('no_charges')
    // Inside her cast or action window (auto-claw keeps her busy most of the time): the act waits for her to be free
    // (QUEUE_MS at most), then runs with its checks done again; the auto-claw resumes after it.
    if (this.busy(t, m, now)) {
      t.queued = { msg, until: now + QUEUE_MS }
      t.lastActAt = now
      return true
    }
    let target: Player | null = null
    if (msg.target !== undefined) {
      const q = this.hunter(pilot, msg.target)
      if ('ok' in q) return q
      target = q
    }
    if (e.target === 'entity' && !target) return fail('not_found', 'Pick a hunter first.')
    const def = e.def
    if (!('kind' in def) || def.kind === undefined) {
      const row = e.row!
      if (!target) {
        target = this.nearest(m, row, now)
        if (!target) return fail('too_far', 'No hunter within reach.')
      }
      const d = this.g.world.distance(m, target, now)
      const reach = this.g.mobSkills.reach(m, row, target)
      if (msg.repeat && e.id === t.conf.kit[0]?.id) {
        if (d > reach + CLAW_CHASE_M) return fail('too_far')
        this.stopOrders(t)
        t.claw = { target: target.id, planAt: 0 }
        t.lastActAt = now
        this.endStalk(t, m, now)
        m.target = target.id
        return true
      }
      if (d > reach + WALK_IN_M) return fail('too_far')
      this.stopOrders(t)
      t.lastActAt = now
      this.endStalk(t, m, now)
      m.target = target.id
      if (d <= reach) this.useRow(t, m, row, target, now)
      else t.pending = { entry: e, target: target.id, until: now + PENDING_MS, planAt: 0 }
      return true
    }
    this.stopOrders(t)
    switch (def.kind) {
      case 'leap': {
        let x: number
        let z: number
        if (target) [x, , z] = this.g.world.positionAt(target, now)
        else if (msg.x !== undefined && msg.z !== undefined) {
          x = msg.x
          z = msg.z
        } else return fail('not_found', 'Pick a hunter or a spot on the ground.')
        const r = this.leap(t, m, e, def, target, x, z, now)
        if (r !== true) return r
        break
      }
      case 'fear':
        this.roar(t, m, e, def, now)
        break
      case 'pack': {
        const r = this.pack(t, m, e, def, target, now)
        if (r !== true) return r
        break
      }
      case 'stalk': {
        const at = this.g.world.positionAt(m, now)
        if (this.g.data.inSafeArea(this.g.config.world, at[0], at[2])) return fail('safe_zone')
        this.startStalk(t, m, e, def, now)
        break
      }
    }
    t.lastActAt = now
    if (target) m.target = target.id
    return true
  }

  /** Auto-claw and a pending walk-in end; the act that replaces them starts. */
  stopOrders(t: Turn): void {
    t.claw = null
    t.pending = null
    t.queued = null
  }

  /** The nearest attackable hunter within `row`'s reach (Sweep without a target). */
  private nearest(m: Mob, row: SkillDef, now: number): Player | null {
    const at = this.g.world.positionAt(m, now)
    let best: Player | null = null
    let bestD = Infinity
    for (const q of this.g.playersNear(at[0], at[2], row.range + m.radius + 2)) {
      const d = this.g.world.distance(m, q, now)
      if (d <= this.g.mobSkills.reach(m, row, q) && d < bestD) {
        best = q
        bestD = d
      }
    }
    return best
  }

  private useRow(_t: Turn, m: Mob, row: SkillDef, target: Player, now: number): void {
    this.g.mobSkills.use(m, row, target, now)
  }

  private cast(m: Mob, e: KitEntry, now: number, actionMs: number, target?: Player | null): number {
    const instance = this.instance()
    const msg = { t: 'cast', id: m.id, skill: e.castId, instance, prepareMs: 0, castMs: 0, actionMs: Math.max(0, Math.round(actionMs)), ...(target ? { target: target.id } : {}), ...(e.clip ? { clip: e.clip } : {}) } as const
    this.g.world.broadcastAbout(m, msg)
    return instance
  }

  // ---- Pounce -------------------------------------------------------------------------------------------------

  private leap(t: Turn, m: Mob, e: KitEntry, def: Extract<PilotAbilityDef, { kind: 'leap' }>, target: Player | null, x: number, z: number, now: number): Fail | true {
    const w = this.g.world
    const from = w.livePoint(m, now)
    let dx = x - from.x
    let dz = z - from.z
    const d = Math.hypot(dx, dz)
    const slack = target ? target.radius + m.radius : 0
    if (d > def.rangeM + slack) return fail('too_far')
    // A hunter: she lands just short of him; a point: on it.
    if (target && d > 1e-6) {
      const stand = Math.max(0, d - (m.radius + target.radius) * 0.8)
      dx = (dx / d) * stand
      dz = (dz / d) * stand
    }
    const [cx, cz] = clampToArea(from.x + dx, from.z + dz, t.area)
    if (this.g.data.inSafeArea(this.g.config.world, cx, cz)) return fail('safe_zone')
    this.endStalk(t, m, now)
    const walked = w.walkEntity(m, cx, cz, def.speedMs, now)
    const len = walked && m.move ? Math.hypot(m.move.to[0] - m.move.from[0], m.move.to[2] - m.move.from[2]) : 0
    const landAt = now + (len / def.speedMs) * 1000
    const instance = this.cast(m, e, now, landAt - now + 400, target)
    t.leap = { entry: e, landAt, instance }
    t.busyUntil = landAt + 400
    t.ready.set(e.id, now + def.cooldownMs)
    return true
  }

  /** The leap landed: the row's roll × mul on the hunters around her, and the status on those it hit. */
  private land(t: Turn, m: Mob, now: number): void {
    const l = t.leap!
    t.leap = null
    const def = l.entry.def as Extract<PilotAbilityDef, { kind: 'leap' }>
    const row = l.entry.row
    if (!row || m.ai === 'dead') return
    const at = this.g.world.livePoint(m, now)
    for (const q of this.g.playersNear(at.x, at.z, def.hit.radiusM + m.radius)) {
      const { hits } = this.g.mobSkills.rollHits(m, row, q, def.hit.mul)
      const r = this.g.dealHits(m, q, hits, { skill: l.entry.castId, instance: l.instance, aoe: true }, now)
      if (r.killed || !r.hits.some((h) => h.outcome === 'hit' || h.outcome === 'crit')) continue
      this.g.skills.applyStatus(m, q, { status: { status: def.hit.status, level: m.level, chancePct: 100 }, row }, now)
    }
  }

  // ---- Fear Roar ----------------------------------------------------------------------------------------------

  private roar(t: Turn, m: Mob, e: KitEntry, def: Extract<PilotAbilityDef, { kind: 'fear' }>, now: number): void {
    const w = this.g.world
    this.endStalk(t, m, now)
    w.halt(m, now)
    this.cast(m, e, now, 1200)
    t.busyUntil = now + 1200
    t.ready.set(e.id, now + def.cooldownMs)
    const at = w.livePoint(m, now)
    const row = t.conf.kit.find((k) => k.row)?.row ?? null
    for (const q of this.g.playersNear(at.x, at.z, def.radiusM + m.radius)) {
      if (row) this.g.skills.applyStatus(m, q, { status: { status: 'knockback', level: m.level, chancePct: 100 }, row }, now)
      // Riders are not pushed (the horse shares the rider's move; mounts.ts owns it); they get the status and the lock.
      if (!this.g.mounts.ridden(q) && def.pushM > 0) {
        const qp = w.livePoint(q, now)
        let dx = qp.x - at.x
        let dz = qp.z - at.z
        const d = Math.hypot(dx, dz)
        if (d < 1e-3) {
          const a = this.s.rng() * Math.PI * 2
          dx = Math.sin(a)
          dz = Math.cos(a)
        } else {
          dx /= d
          dz /= d
        }
        w.walkEntity(q, qp.x + dx * def.pushM, qp.z + dz * def.pushM, ROAR_PUSH_SPEED, now)
        q.yaw = yawTowards(-dx, -dz)
      }
      this.s.lock(q, now + def.lockMs)
    }
    this.s.roared(t, m, now)
  }

  // ---- Call the Pack ------------------------------------------------------------------------------------------

  private pack(t: Turn, m: Mob, e: KitEntry, def: Extract<PilotAbilityDef, { kind: 'pack' }>, target: Player | null, now: number): Fail | true {
    // the Climb (docs/CLIMB.md §2.6): her pack follows her summons' remap (White Tigers -> Tiger Girl's Guard)
    const mapped = this.g.uniques?.unique(m.def.code)?.def.summons.mobs?.[def.mob]
    const mob = (mapped ? this.g.data.mob(mapped) : undefined) ?? this.g.data.mob(def.mob)
    if (!mob) return fail('not_found')
    const w = this.g.world
    this.endStalk(t, m, now)
    const at = w.livePoint(m, now)
    const current = m.target === null ? undefined : this.g.target(m.target)
    const prey: Player | null = target ?? current ?? this.g.playersNear(at.x, at.z, 30)[0] ?? null
    const ids: number[] = []
    for (let i = 0; i < def.count; i++) {
      const a = this.s.rng() * Math.PI * 2
      const r = 1.5 + this.s.rng() * 2
      const [x, z] = w.clamp(at.x + Math.sin(a) * r, at.z + Math.cos(a) * r)
      const wk = this.g.nav.kind === 'mesh' ? this.g.nav.walk(at, x, z) : null
      const p = wk && Number.isFinite(wk.end.y) ? wk.end : { x, y: at.y, z, surface: at.surface }
      const add = this.g.createMob(mob, 'normal', p.x, p.z, p.y, null, now, p.surface)
      if (prey) {
        add.ai = 'chase'
        add.target = prey.id
        add.nextThinkAt = 0
      }
      ids.push(add.id)
    }
    this.g.mobSkills.adopt(m, ids)
    w.halt(m, now)
    this.cast(m, e, now, 1000, prey)
    t.busyUntil = now + 1000
    t.charges.set(e.id, (t.charges.get(e.id) ?? def.charges) - 1)
    t.ready.set(e.id, now + def.cooldownMs)
    return true
  }

  // ---- Stalk --------------------------------------------------------------------------------------------------

  private startStalk(t: Turn, m: Mob, e: KitEntry, def: Extract<PilotAbilityDef, { kind: 'stalk' }>, now: number): void {
    m.veil = def.revealM
    t.stalk = { entry: e, until: now + def.maxMs }
    this.s.respeed(t, m, now)
    this.g.world.refreshAround(m, now)
  }

  /** Stalk ends (any act, damage taken, its time, the AI's handover): she shows again; the cooldown starts now. */
  endStalk(t: Turn, m: Mob, now: number): void {
    const st = t.stalk
    if (!st) return
    t.stalk = null
    delete m.veil
    t.ready.set(st.entry.id, now + st.entry.cooldownMs)
    this.s.respeed(t, m, now)
    if (m.ai !== 'dead') this.g.world.refreshAround(m, now)
  }

  // ---- the tick ------------------------------------------------------------------------------------------------

  /** Leaps landing, Stalk's end, auto-claw and a walk into reach (player steering only for the last two). */
  tick(t: Turn, m: Mob, pilot: Player | null, now: number): void {
    if (t.leap && now >= t.leap.landAt) this.land(t, m, now)
    if (t.stalk && now >= t.stalk.until) this.endStalk(t, m, now)
    if (t.steering !== 'player' || !pilot) return
    if (this.g.skills.held(m, now) || this.busy(t, m, now)) return
    const qd = t.queued
    if (qd) {
      t.queued = null
      if (now <= qd.until) {
        const claw = t.claw
        t.lastActAt = -Infinity
        const r = this.act(t, m, pilot, qd.msg, now)
        if (r === true && claw && !t.claw && !t.pending && !t.queued) t.claw = { target: claw.target, planAt: 0 }
        return
      }
    }
    const pd = t.pending
    if (pd) {
      const q = pd.target === null ? null : this.g.target(pd.target)
      if (now > pd.until || !q || !pilot.known.has(q.id) || !pd.entry.row) t.pending = null
      else if (this.chase(t, m, pd.entry.row, q, now, pd)) {
        t.pending = null
        this.useRow(t, m, pd.entry.row, q, now)
      }
      return
    }
    const c = t.claw
    if (!c) return
    const q = this.g.target(c.target)
    const row = t.conf.kit[0]?.row
    if (!q || !row || !pilot.known.has(q.id)) {
      t.claw = null
      return
    }
    const reach = this.g.mobSkills.reach(m, row, q)
    if (this.g.world.distance(m, q, now) > reach + CLAW_CHASE_M) {
      t.claw = null
      return
    }
    if (this.chase(t, m, row, q, now, c) && this.g.mobSkills.readyAt(m, row.code) <= now) this.useRow(t, m, row, q, now)
  }

  /** In reach of `q` for `row`: true; else she runs to just inside reach (re-planned every REPLAN_MS). */
  private chase(t: Turn, m: Mob, row: SkillDef, q: Player, now: number, plan: { planAt: number }): boolean {
    const w = this.g.world
    const reach = this.g.mobSkills.reach(m, row, q)
    const mp = w.positionAt(m, now)
    const qp = w.positionAt(q, now)
    const d = Math.hypot(qp[0] - mp[0], qp[2] - mp[2])
    if (d <= reach) {
      w.halt(m, now, yawTowards(qp[0] - mp[0], qp[2] - mp[2]))
      return true
    }
    if (now >= plan.planAt) {
      plan.planAt = now + REPLAN_MS
      const stand = reach * 0.8
      const [x, z] = clampToArea(qp[0] + ((mp[0] - qp[0]) / d) * stand, qp[2] + ((mp[2] - qp[2]) / d) * stand, t.area)
      w.moveEntity(m, x, z, this.s.speedOf(t, m), now)
    }
    return false
  }
}

/** Taunt lines the kit ships (§3.6; client i18n `pilot.taunt.<line>`). */
export const TAUNT_LINES = PILOT_TAUNT_LINES
