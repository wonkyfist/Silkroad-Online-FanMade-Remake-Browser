/**
 * The casting presentation (docs/SKILLS.md §5, §6, §10.3), an ActionPlayer: `cast` plays READY (prepareMs), WAIT
 * (looping, castMs) and SHOT from the skill's aniGroup (falling back to the default group); `combat {instance}` hits
 * show at their damage cues (hit i at `hitCues[i]`, i.e. the N-th hit event of that phase's clip, or at `combat.at`
 * for projectiles), falling back to the release time; chain segments continue the clip the head started instead of
 * restarting it; `castEnd` stops the clip. No Babylon: the actor is behind `ActionPort`, the clock is passed in (local
 * milliseconds), so tests drive it with a fake clock. Effects and sounds follow the `onPhase`/`onEnd` callbacks.
 */
import type { CombatHit, ServerMessage, SkillDef } from '@sro/shared'
import type { SkillCatalog } from '../content/skills.ts'

export type CastMessage = Extract<ServerMessage, { t: 'cast' }>
export type CastEndMessage = Extract<ServerMessage, { t: 'castEnd' }>
export type SkillCombat = Extract<ServerMessage, { t: 'combat' }>

export type PhaseName = 'READY' | 'WAIT' | 'SHOT'

/** A clip's facts as the actor has them (sidecar duration and sorted type-1 events). */
export interface ClipFacts {
  durationMs: number
  hits: readonly number[]
}

/** One phase to play: the clip's TYPE_NAME in `aniGroup`, held `ms`, looping or not. */
export interface PhasePlan {
  phase: PhaseName
  type: string
  ms: number
  loop: boolean
}

/** What the ActionPlayer needs of an entity (EntityView + CharacterActor in the game, a fake in tests). */
export interface ActionPort {
  clip(aniGroup: string | undefined, type: string): ClipFacts | null
  /** Plays the phases in turn; returns a token for stop/playing (null: nothing could play). */
  play(aniGroup: string | undefined, phases: readonly PhasePlan[]): number | null
  stop(token: number): void
  playing(token: number): boolean
  face(targetId: number): void
}

/** One running action (a cast, or a whole chain). */
export interface SkillAction {
  caster: number
  /** Instances shown by this action (a chain adds one per segment). */
  instances: number[]
  /** The row of the latest cast (the current chain segment). */
  def: SkillDef | undefined
  skill: string
  group: string
  /** Chain root (or the row itself). */
  root: string
  target?: number
  /** Local ms of each phase start, with its clip facts. */
  phases: { plan: PhasePlan; start: number; clip: ClipFacts | null }[]
  /** Local ms of the release (t0 + prepare + cast) and of the planned end. */
  start: number
  release: number
  end: number
  token: number | null
  ended: boolean
  /** The planned end passed without an early end (onFinish ran). */
  done?: boolean
}

export interface ActionPlayerOptions {
  /** A phase started (fx stages, sounds). */
  onPhase?(a: SkillAction, phase: PhasePlan, start: number, clip: ClipFacts | null): void
  /** An instant skill was used (no clip: imbues, Grass Walk). */
  onInstant?(msg: CastMessage, def: SkillDef | undefined): void
  /** The action ended early (castEnd) or was replaced. */
  onEnd?(a: SkillAction, reason: string): void
  /** The action reached its planned end (no castEnd, not replaced): e.g. the weapon shows again. */
  onFinish?(a: SkillAction): void
  /** A chain segment (chainIndex > 1) continued the action at local ms `now`; `index` is its chainIndex. */
  onSegment?(a: SkillAction, index: number, now: number): void
  /**
   * A row for a skill without data (mob skills before wave 8's MSKILL rows, docs/WAVE_PLAN2.md D4): the caller builds
   * one from the fx index (clips, hit cues), so the cast plays like a player skill.
   */
  fallbackDef?(skill: string): SkillDef | undefined
}

/** Spacing of hits without any cue or event (ms). */
const HIT_GAP = 140
/** Actions are forgotten this long after their end. */
const KEEP_MS = 20_000
/** Longest a projectile's shown hit waits for the client's later launch (ms). */
const MAX_LAUNCH_LAG = 600

/**
 * How much later than the release the client launches a projectile cue (ms, 0 for other cues). The server times a
 * projectile's landing (`combat.at`) from the release, while the client launches it at its clip event (skilleffect's
 * SHOT@eN rows); on rows whose cast time ends before that event (Cold wave - Arrest: about 96 ms) the hit is shown
 * this much later, so the bolt, its impact and the damage number arrive together (FX lab H2).
 */
function launchLag(a: SkillAction, cue: NonNullable<SkillDef['hitCues']>[number] | undefined): number {
  if (!cue?.projectile || cue.event <= 0) return 0
  const phase = a.phases.find(p => p.plan.phase === cue.phase)
  const ev = phase?.clip?.hits[cue.event - 1]
  if (!phase || ev === undefined) return 0
  return Math.max(0, Math.min(MAX_LAUNCH_LAG, phase.start + ev - a.release))
}

/** Clip TYPE_NAMEs of an `animation` phase ('SKILL_1'; basic attacks list several, the first is used). */
function clipType(v: string | undefined): string | null {
  const first = v?.split(',')[0]?.trim().replace(/^ANI_/, '')
  return first || null
}

/**
 * The phases of a cast (SKILLS.md §5.1): with a prepare time READY holds it (plus the cast when there is no WAIT
 * clip), WAIT loops for the cast, SHOT plays the action; without one SHOT plays from t0 for cast + action. A chain head
 * holds SHOT for its whole clip (the segments' hit events are in it). Castle Shield-like rows (0/0) have none.
 */
export function planPhases(msg: Pick<CastMessage, 'prepareMs' | 'castMs' | 'actionMs'>, def: SkillDef | undefined, clip: (type: string) => ClipFacts | null): PhasePlan[] {
  const anim = def?.animation ?? {}
  const ready = clipType(anim.ready)
  const wait = clipType(anim.wait)
  const shot = clipType(anim.shot)
  const prep = Math.max(0, msg.prepareMs)
  const cast = msg.castMs > 1 ? msg.castMs : 0
  const out: PhasePlan[] = []
  if (prep > 0) {
    const waitOk = !!wait && cast > 0
    if (ready) out.push({ phase: 'READY', type: ready, ms: prep + (waitOk ? 0 : cast), loop: false })
    if (waitOk) out.push({ phase: 'WAIT', type: wait!, ms: ready ? cast : prep + cast, loop: true })
  }
  if (shot) {
    let ms = prep > 0 ? msg.actionMs : cast + msg.actionMs
    if (def?.chainNext) ms = Math.max(ms, clip(shot)?.durationMs ?? 0)
    if (ms > 0 || !out.length) out.push({ phase: 'SHOT', type: shot, ms: Math.max(ms, 1), loop: false })
  }
  return out
}

export class ActionPlayer {
  private readonly byInstance = new Map<number, SkillAction>()
  private readonly byCaster = new Map<number, SkillAction>()
  private queue: { at: number; seq: number; fn: () => void }[] = []
  private seq = 0
  /** Local ms of the latest tick. */
  private clock = -Infinity

  constructor(private readonly catalog: SkillCatalog, private readonly opts: ActionPlayerOptions = {}) {}

  /** The running (or latest) action of a caster. */
  actionOf(caster: number): SkillAction | undefined {
    return this.byCaster.get(caster)
  }

  action(instance: number): SkillAction | undefined {
    return this.byInstance.get(instance)
  }

  /** `cast` from the server, received at local time `now`. */
  cast(msg: CastMessage, now: number, port: ActionPort | null): SkillAction | null {
    // Play the Boss (docs/PLAY_THE_BOSS.md §3.5): a server-built ability (PILOT_*) no catalog knows plays its `clip`.
    const def = this.catalog.get(msg.skill) ?? this.opts.fallbackDef?.(msg.skill) ?? (msg.clip ? clipSkillDef(msg.skill, msg.clip) : undefined)
    if (msg.instant) {
      this.opts.onInstant?.(msg, def)
      return null
    }
    // Basic attacks and skills without data (mob skills) keep the default attack presentation.
    if (!def || def.basicAttack) return null
    const prev = this.byCaster.get(msg.id)
    const root = def?.chainRoot ?? msg.skill
    // A chain segment continues the head's clip (SKILLS.md §5.2): same root, still playing.
    if (prev && !prev.ended && def?.chainIndex !== undefined && def.chainIndex > 1 && prev.root === root && (prev.token === null || port?.playing(prev.token))) {
      prev.instances.push(msg.instance)
      prev.def = def
      prev.skill = msg.skill
      prev.release = now + msg.castMs
      prev.end = Math.max(prev.end, now + msg.castMs + msg.actionMs)
      if (msg.target !== undefined) prev.target = msg.target
      this.byInstance.set(msg.instance, prev)
      this.opts.onSegment?.(prev, def.chainIndex, now)
      return prev
    }
    if (prev && !prev.ended) this.finish(prev, 'replaced', port)
    const aniGroup = def?.aniGroup
    const plans = planPhases(msg, def, type => port?.clip(aniGroup, type) ?? null)
    const a: SkillAction = {
      caster: msg.id,
      instances: [msg.instance],
      def,
      skill: msg.skill,
      group: def?.group ?? this.catalog.groupOf(msg.skill),
      root,
      ...(msg.target !== undefined ? { target: msg.target } : {}),
      phases: [],
      start: now,
      release: now + msg.prepareMs + (msg.castMs > 1 ? msg.castMs : 0),
      end: now + msg.prepareMs + msg.castMs + msg.actionMs,
      token: null,
      ended: false,
    }
    let t = now
    for (const plan of plans) {
      a.phases.push({ plan, start: t, clip: port?.clip(aniGroup, plan.type) ?? null })
      t += plan.ms
    }
    a.end = Math.max(a.end, t)
    if (msg.target !== undefined && msg.target !== msg.id) port?.face(msg.target)
    a.token = plans.length && port ? port.play(aniGroup, plans) : null
    this.byInstance.set(msg.instance, a)
    this.byCaster.set(msg.id, a)
    for (const p of a.phases) {
      const phase = p
      this.at(phase.start, () => {
        if (!a.ended) this.opts.onPhase?.(a, phase.plan, phase.start, phase.clip)
      })
    }
    this.watchEnd(a)
    return a
  }

  /** Runs `fn` at local ms `at` on this player's clock (at the next tick when already due). */
  schedule(at: number, fn: () => void): void {
    this.at(at, fn)
  }

  /** onFinish once the (possibly extended) planned end has passed without an early end. */
  private watchEnd(a: SkillAction): void {
    this.at(a.end, () => {
      if (a.ended || a.done) return
      if (this.clock < a.end) return this.watchEnd(a)
      a.done = true
      this.opts.onFinish?.(a)
    })
  }

  /** `castEnd`: the action stops (its clip and loops); hits already on their way still show. */
  castEnd(msg: CastEndMessage, port: ActionPort | null): void {
    const a = this.byInstance.get(msg.instance)
    if (a && !a.ended) this.finish(a, msg.reason, port)
  }

  /**
   * Times the hits of a skill `combat` (it has `instance`): `show(i)` runs at hit i's moment (now at the latest).
   * Returns false for combats without an instance (basic attacks) or whose cast was not seen (the caster came into
   * view mid-action, a mob skill without skill data): they keep the default attack presentation.
   */
  combat(msg: SkillCombat, now: number, serverNow: number, show: (i: number) => void): boolean {
    if (msg.instance === undefined) return false
    const a = this.byInstance.get(msg.instance)
    if (!a) return false
    const times = this.hitTimes(a, msg, now, serverNow)
    times.forEach((at, i) => this.at(Math.max(now, at), () => show(i)))
    return true
  }

  /** Local times of each hit of `msg` (exported for tests through `combat`). */
  hitTimes(a: SkillAction | undefined, msg: Pick<SkillCombat, 'hits' | 'at' | 'skill'>, now: number, serverNow: number): number[] {
    const hits: readonly CombatHit[] = msg.hits
    const def = a ? ((msg.skill ? this.catalog.get(msg.skill) : undefined) ?? a.def) : undefined
    const cues = def?.hitCues ?? []
    if (msg.at !== undefined) {
      const land = now + (msg.at - serverNow)
      return hits.map((_, i) => land + (a ? launchLag(a, cues[i] ?? cues[cues.length - 1]) : 0) + i * HIT_GAP)
    }
    if (!a) return hits.map((_, i) => now + i * HIT_GAP)
    return hits.map((_, i) => {
      const cue = cues[i] ?? cues[cues.length - 1]
      const phase = a.phases.find(p => p.plan.phase === (cue?.phase ?? 'SHOT')) ?? a.phases[a.phases.length - 1]
      if (!phase) return a.release + i * HIT_GAP
      const event = cue ? cue.event : i + 1
      const extra = cues.length && i >= cues.length ? (i - cues.length + 1) * HIT_GAP : 0
      if (event === 0) return phase.start + extra
      const ev = phase.clip?.hits[event - 1]
      if (ev !== undefined) return phase.start + ev + extra + (cue?.projectile?.delayMs ?? 0)
      return Math.max(a.release, phase.start) + (cues.length ? extra : i * HIT_GAP)
    })
  }

  /** Runs due work; call every frame with local ms. */
  tick(now: number): void {
    this.clock = now
    if (this.queue.length) {
      const due = this.queue.filter(q => q.at <= now)
      if (due.length) {
        this.queue = this.queue.filter(q => q.at > now)
        due.sort((x, y) => x.at - y.at || x.seq - y.seq)
        for (const d of due) {
          try {
            d.fn()
          } catch (err) {
            console.error('[skills] action step failed', err)
          }
        }
      }
    }
    for (const [inst, a] of this.byInstance) {
      if (now - a.end > KEEP_MS) {
        this.byInstance.delete(inst)
        if (this.byCaster.get(a.caster) === a) this.byCaster.delete(a.caster)
      }
    }
  }

  /** A caster left view or died: its action ends without touching its (gone) model. */
  forget(caster: number): void {
    const a = this.byCaster.get(caster)
    if (a && !a.ended) this.finish(a, 'gone', null)
    this.byCaster.delete(caster)
  }

  clear(): void {
    for (const a of this.byCaster.values()) if (!a.ended) this.finish(a, 'gone', null)
    this.byInstance.clear()
    this.byCaster.clear()
    this.queue = []
  }

  private finish(a: SkillAction, reason: string, port: ActionPort | null): void {
    const done = a.done
    a.ended = true
    if (done) return
    if (a.token !== null && port) port.stop(a.token)
    this.opts.onEnd?.(a, reason)
  }

  private at(at: number, fn: () => void): void {
    this.queue.push({ at, seq: this.seq++, fn })
  }
}

/** What mobSkillDef reads of an fx index group (world/skill-fx.ts FxSkill, v2). */
export interface FxGroupFacts {
  group: string
  aniGroup: string | null
  clips?: { ready: string | null; wait: string | null; shot: string | null }
  stages: readonly { phase: string; startEvent: number; actType: string; move: string; dmg?: boolean }[]
}

/**
 * The hit cues of an fx group (its DMG rows in phase order and start event; a DMG flight carries its projectile),
 * like the data export's `hitCues`; one SHOT event-1 cue when it has none.
 */
export function hitCuesOf(g: FxGroupFacts): NonNullable<SkillDef['hitCues']> {
  const order = ['READY', 'WAIT', 'SHOT']
  const seen = new Set<string>()
  const cues: NonNullable<SkillDef['hitCues']> = []
  const rows = g.stages.filter(s => s.dmg === true && order.includes(s.phase)).sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase) || a.startEvent - b.startEvent)
  for (const s of rows) {
    const k = `${s.phase}:${s.startEvent}`
    if (seen.has(k)) continue
    seen.add(k)
    const cue: NonNullable<SkillDef['hitCues']>[number] = { phase: s.phase, event: s.startEvent }
    if (s.actType.startsWith('AT_MOV_')) {
      const [move = 'MOV_STRAIGHT', delay, speed] = s.move.split(',')
      cue.projectile = { move, delayMs: Math.max(0, Number(delay) || 0), speed: Number(speed) || 300 }
    }
    cues.push(cue)
  }
  return cues.length ? cues : [{ phase: 'SHOT', event: 1 }]
}

/**
 * A SkillDef stand-in for a mob skill (MSKILL_*) built from its fx index group (docs/WAVE_PLAN2.md D4): the clips of
 * skillaniset2 (`ANI_ATTACK2` -> 'ATTACK2', the first of a list), the DEFAULT aniGroup and the hit cues of its DMG
 * rows. Only the presentation reads it (the ActionPlayer); the server owns the numbers.
 */
export function mobSkillDef(g: FxGroupFacts): SkillDef {
  const animation: NonNullable<SkillDef['animation']> = {}
  const ready = clipType(g.clips?.ready ?? undefined)
  const wait = clipType(g.clips?.wait ?? undefined)
  const shot = clipType(g.clips?.shot ?? undefined)
  if (ready) animation.ready = ready
  if (wait) animation.wait = wait
  if (shot) animation.shot = shot
  return {
    code: g.group,
    id: 0,
    name: null,
    mastery: null,
    masteryLevel: 0,
    skillLevel: 1,
    sp: 0,
    mp: 0,
    category: 'melee',
    castMs: 0,
    actionMs: 0,
    cooldownMs: 0,
    range: 0,
    weapons: [],
    icon: null,
    group: g.group,
    animation,
    kind: 'attack',
    aniGroup: g.aniGroup ?? 'DEFAULT',
    hitCues: hitCuesOf(g),
  } as SkillDef
}

/**
 * Play the Boss (docs/PLAY_THE_BOSS.md §3.5, `cast.clip`): the minimal SkillDef of a server-built ability whose code no
 * catalog knows (PILOT_TIGERWOMAN_POUNCE): one SHOT phase of clip type `clip` ('ATTACK1', 'FIND', 'HELP') in the
 * DEFAULT group, its hit at the clip's first hit event. Presentation only; the server owns the numbers.
 */
export function clipSkillDef(skill: string, clip: string): SkillDef | undefined {
  const shot = clipType(clip)
  if (!shot) return undefined
  return mobSkillDef({ group: skill, aniGroup: 'DEFAULT', clips: { ready: null, wait: null, shot }, stages: [] })
}

/** The clip TYPE_NAME of an animation cell ('ANI_ATTACK1,ANI_ATTACK2' -> 'ATTACK1'). */
export function clipTypeOf(v: string | null | undefined): string | null {
  return clipType(v ?? undefined)
}
