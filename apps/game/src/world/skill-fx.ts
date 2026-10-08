/**
 * Skill effects (docs/SKILLS.md §7, docs/EFFECTS.md §2, §3.1-§3.4): the stage rows of /out/fx/skills.json (fx index
 * v2, packages/convert/src/fx/skills.ts) played with @sro/fx. Visual only; everything is keyed by the skill group
 * (Basic_Group; a mob skill's group is its MSKILL code).
 *
 * Stages (skilleffectset rows) of a phase (READY / WAIT / SHOT, ACT_S when a buff lands) start at the phase start +
 * the clip's hit event `startEvent` (0 = the phase start) and are placed by their ActType (world/fx/anchors.ts):
 *  - AT_ONE_FOLLOW / AT_LOOP: on the caster, at the start bone (or the root) plus the offset turned with the caster
 *    (and rolled by col 24 or `SCT_RUT,<deg>`), following the bone every tick; AT_LOOP rows run until their phase
 *    ends, a Kill row naming their ID plays, a Trade flight takes them, or (ACT_L) the buff ends;
 *  - AT_DMG_POS: at the victim's characterInfo DamagePos (+ the row offset in the attacker's frame);
 *    AT_TARGET: at the target's root + offset (with a move it falls from its start offset to its target offset);
 *  - AT_MOV_* (1TAR, SPLASH, OPTION): flies from the caster's start bone to the target root + TargetOffset (in the
 *    target's frame) at MovTypeSpeed (dm/s; MOV_UPR arcs Param[0] dm; MOV_PIERCE flies on past the target), then
 *    plays `effect2`. `.bsr` objects (arrows) fly their converted model with the skill's arrow tail and force effect.
 * DMG stages play when the hit they belong to is shown (the ActionPlayer's cue time, `hit()`); a caster-anchored DMG
 * row plays once per (instance, cue), a victim-anchored one on every victim. A damage projectile waits for its hit
 * (at most HOLD_MS past its computed arrival) and lands with it.
 * Per landed hit, in order: DMG rows, the DamageEfp spark at the DamagePos (Berserk's HWAN spark when the hit is
 * `hwan`), the victim's BloodType (`_down` while knocked down), the DefenseEfp of the victim's shield buff, the
 * attacker's imbue DamageEfp, the LIGHT_n flash. Blocks play `system/ch_blocking.efp` and the DEFENCE clip.
 * Weapon trails (world/fx/trail.ts) swing with basic attacks and SHOT phases; an imbue's trail (priority 2) or
 * Berserk's (10) replaces the row's while the attacker carries it. Buffs play ACT_S once and loop ACT_L on their
 * carrier until effectRemove. Statuses loop their battle/status_bad_*.efp (mobs: the model's own monster/ set).
 * Programs load lazily (a group's effects are preloaded when its first phase starts); a missing one is skipped
 * (warned once). Every instance is disposed when it finishes or at its time cap; `stats` counts them for tests.
 */
import type { Scene } from '@babylonjs/core'
import { FxInstance, FxLibrary, FxStreak, type FxEffect, type FxRootPose, type V3 } from '@sro/fx'
import type { SkillStatusKind } from '@sro/shared'
import { OUT } from '../content/catalog.ts'
import type { EntityView } from './entities.ts'
import {
  anchorPoint,
  add,
  bodyPoint,
  damagePoint,
  dist,
  facing,
  flightEnd,
  infoOf,
  lerp,
  lightColor,
  lookAlong,
  mobBaseScale,
  parseOffset,
  readCharacters,
  readLights,
  rootPoint,
  rotate,
  scaleV,
  stageScale,
  type CharacterIndex,
} from './fx/anchors.ts'
import { fireTrail } from './fx/berserk-look.ts'
import { arrowModel, BASIC_ARROW, FxModels, type FxModelInstance, type FxModelLoader } from './fx/fx-model.ts'
import { HitLights } from './fx/hit-light.ts'
import { PERF } from './perf.ts'
import { trailStyle, WeaponTrail, type TrailStyle } from './fx/trail.ts'
import { RARITY_LOOKS } from '../three/weapon-rarity.ts'
import { rarityFxOf } from './rarity/fx.ts'
import type { RarityTier } from '@sro/shared'
import type { FxCharacterInfo, FxLabEntry, FxLight, FxModelRef, FxTrail } from './fx/types.ts'

export { bodyPoint, parseOffset } from './fx/anchors.ts'

/** How long a basic attack's seal swing samples the blade (s; the ribbon then lingers by its kind and tier). */
export const RARE_SWING_S = 0.75

/** A seal weapon's swing trail (docs/RARITY.md §5.4): the row's texture in the tier's colour and blend, longer. */
export function rarityTrail(style: TrailStyle, tier: RarityTier): TrailStyle {
  const L = RARITY_LOOKS[tier]
  return { ...style, lengthMs: Math.round(style.lengthMs * L.trailLength), color: [L.trail[0], L.trail[1], L.trail[2], L.trailAlpha], blend: L.trailBlend }
}

export interface FxStage {
  phase: string
  startEvent: number
  actType: string
  move: string
  effect: string | null
  startBone: string | null
  startOffset: string
  targetBone: string | null
  targetOffset: string
  effect2: string | null
  rotate: string
  script: string | null
  /** DMG Event flag (exports before wave 5 lack it: then every row plays with its phase). */
  dmg?: boolean
  /** Kill column: this row ends the caster's looping stages with that ID (v1: all of them). */
  kill?: number
  /** SndBegin/SndEnd sound keys (played by the sound feature, not here). */
  sound?: { begin: string | null; end: string | null }
  /** Object as stored (.efp or .bsr path). */
  object?: string
  // ---- fx index v2 (optional here: v1 exports lack them) ----
  id?: number
  trade?: number
  fade?: { inMs: number; outMs: number }
  param?: [number, number, number]
  scale?: 'CHAR_BASE' | 'MOB_BASE' | null
  damageTypes?: ('NOR' | 'CRI' | 'HWAN')[] | null
  objectModel?: FxModelRef | null
}

export interface FxSkill {
  group: string
  aniGroup: string | null
  defense: string | null
  damage: string | null
  arrowTail: string | null
  arrowForce: string | null
  stages: FxStage[]
  // ---- fx index v2 (optional here) ----
  /** skillaniset2 clips ('ANI_ATTACK1', ...). */
  clips?: { ready: string | null; wait: string | null; shot: string | null }
  priority?: number
  hideWeapon?: boolean
  trail?: FxTrail | null
  light?: string | null
  twist?: string | null
  bleeds?: boolean
  kind?: 'player' | 'mob' | 'system'
}

/** The cue of a shown hit (skills.json `hitCues[i]`). */
export interface HitCueRef {
  phase: string
  event: number
}

/** Concurrent instances kept at most (older one-shots are dropped first). */
const MAX_LIVE = 96
/** One-shot effects are disposed after this even if they never report finished (ms; longer programs get their own length). */
const ONE_SHOT_MS = 6000
/** Time a flight may take at most (ms). */
const MAX_FLIGHT_MS = 3000
/** A damage projectile waits this long past its computed arrival for its hit (ms). */
export const HOLD_MS = 400
/** A hit shown this soon before its damage projectile launches lets that projectile land on its own (ms). */
const EARLY_HIT_MS = 600
/** Stopped effects fade out within this (ms). */
const FADE_MS = 3000
/** Arrow speed of bow basic attacks: skilleffect arrows fly 500 dm/s (2 Arrow Combo's row, docs/EFFECTS.md §2.2). */
const ARROW_SPEED = 50
/** A piercing flight flies this far past its target (m). */
const PIERCE_M = 8
/** Block effect (docs/EFFECTS.md §3.1). */
export const BLOCK_FX = 'system/ch_blocking.efp'
/** Berserk's aniset (docs/EFFECTS.md §3.9): HWAN DamageEfp and trail, priority 10. */
export const HWAN_GROUP = 'SYSTEM_CH_HWANMODE'
/** An idle trail is kept this long for the next swing before it is disposed (ms). */
const TRAIL_KEEP_MS = 3000
/** Trails keep swinging at most this long when following an attack clip. */
const SWING_CAP_MS = 2500

/**
 * Status visuals (Particles.pk2 battle/status_bad_*.efp) and where they sit: `loop` repeats while the status lasts,
 * `on`/`off` play once when it starts/ends. Anchors are [our rule]: the programs carry no bone.
 */
export const STATUS_FX: Partial<Record<SkillStatusKind, { loop?: string; on?: string; off?: string; at: 'head' | 'body' | 'waist' | 'feet' }>> = {
  freeze: { on: 'battle/status_bad_icing_on.efp', off: 'battle/status_bad_icing_off.efp', at: 'feet' },
  frostbite: { loop: 'battle/status_bad_frostbite.efp', at: 'body' },
  shock: { loop: 'battle/status_bad_eshock.efp', at: 'body' },
  burn: { loop: 'battle/status_bad_burn.efp', at: 'waist' },
  poison: { loop: 'battle/status_bad_poison.efp', at: 'waist' },
  zombie: { loop: 'battle/status_bad_zombie.efp', at: 'waist' },
  darkness: { loop: 'battle/status_bad_blind.efp', at: 'head' },
  stun: { loop: 'battle/status_bad_stun.efp', at: 'head' },
}

/** BSR status set names by status (docs/EFFECTS.md §3.2): `status_bad_<name>` on the mob's own model. */
const STATUS_SET: Partial<Record<SkillStatusKind, { loop?: string; on?: string; off?: string }>> = {
  freeze: { on: 'status_bad_icing_on', off: 'status_bad_icing_off' },
  frostbite: { loop: 'status_bad_frostbite' },
  shock: { loop: 'status_bad_eshock' },
  burn: { loop: 'status_bad_burn' },
  poison: { loop: 'status_bad_poison' },
}

/** A model's status particle (sidecar `particles`, kind 'status'): its program and where on the model it sits. */
export interface StatusParticle {
  efp: string
  bone: string | null
  position: V3
}

/** Status sets of a view's model by set name (null = the model has none; undefined = not known yet). */
export type StatusSource = (view: EntityView) => ReadonlyMap<string, StatusParticle> | null | undefined

/** Reads the fx index (tolerant: unknown shapes give an empty map). */
export function readFxSkills(json: unknown): Map<string, FxSkill> {
  const out = new Map<string, FxSkill>()
  const list = (json as { skills?: unknown } | null)?.skills
  if (!Array.isArray(list)) return out
  for (const s of list) {
    if (s && typeof s === 'object' && typeof (s as FxSkill).group === 'string' && Array.isArray((s as FxSkill).stages)) out.set((s as FxSkill).group, s as FxSkill)
  }
  return out
}

/** "MOV_STRAIGHT,<delay ms>,<speed>,<speed>" -> delay and speed in m/s (dm/s / 10); null when it does not move. */
export function parseMove(s: string | null | undefined): { delayMs: number; speed: number } | null {
  const [kind, delay, speed] = (s ?? '').split(',')
  if (!kind || kind === 'MOV_NONE') return null
  const v = Number(speed)
  return { delayMs: Math.max(0, Number(delay) || 0), speed: v > 0 ? v / 10 : 30 }
}

/** MOV_UPR flights (arrows, thrown blades) arc upwards on their way. */
export function arcs(move: string | null | undefined): boolean {
  return (move ?? '').startsWith('MOV_UPR')
}

/** MOV_PIERCE flights fly on past their target (Autumn Wind, M16). */
export function pierces(move: string | null | undefined): boolean {
  return (move ?? '').startsWith('MOV_PIERCE')
}

/** Roll of a stage (col 24: 720 + the slash angle on the slash rows; else the row's `SCT_RUT,<deg>`), in radians. */
export function stageRoll(rotate: string | null | undefined, script?: string | null): number {
  let v = Number(rotate)
  if (!Number.isFinite(v) || v === 0) {
    const m = /^SCT_RUT,(-?\d+(?:\.\d+)?)/.exec(script ?? '')
    v = m ? Number(m[1]) : 0
  }
  if (!Number.isFinite(v) || v === 0) return 0
  return (((v >= 720 ? v - 720 : v) % 360) * Math.PI) / 180
}

/** AT_MOV_1TAR, AT_MOV_SPLASH, AT_MOV_OPTION: the row flies to the target. */
export function isFlight(actType: string): boolean {
  return actType.startsWith('AT_MOV_')
}

/** True when the export carries the DMG Event flag (then damage rows wait for their hits). */
function hasDmgFlags(skill: FxSkill): boolean {
  return skill.stages.some(s => s.dmg === true)
}

/** A damage row that plays at its hit rather than with its phase (projectiles launch with the phase). */
function deferred(skill: FxSkill, st: FxStage): boolean {
  return st.dmg === true && !isFlight(st.actType) && hasDmgFlags(skill)
}

/** A row whose object is a converted model (arrows, the hawk). */
export function isModelRow(st: FxStage): boolean {
  return !!st.objectModel?.glb
}

/** The effect a row plays (flights of a .bsr: the skill's arrow tail), or null. */
function stageKey(skill: FxSkill, st: FxStage): string | null {
  return st.effect ?? (isFlight(st.actType) ? skill.arrowTail : null)
}

/** Rows anchored on the caster (they follow it): FOLLOW / LOOP and anything that is not a victim or flight row. */
export function casterAnchored(st: FxStage): boolean {
  return !isFlight(st.actType) && st.actType !== 'AT_DMG_POS' && st.actType !== 'AT_TARGET'
}

export interface ScheduledStage {
  stage: FxStage
  key: string | null
  /** Local ms the row starts. */
  at: number
}

/**
 * The rows of `phase` that start with it, and when: phase start + the clip's hit event `startEvent` (sorted type-1
 * events, ms from the clip start; 0 or a missing event = the phase start). DMG rows are left to `hit()`. `events`
 * limits the rows to those start events (a chain segment's own slashes, M21).
 */
export function scheduleStages(skill: FxSkill, phase: string, start: number, hits: readonly number[], events?: ReadonlySet<number>): ScheduledStage[] {
  const out: ScheduledStage[] = []
  for (const st of skill.stages) {
    if (st.phase !== phase || deferred(skill, st)) continue
    if (events && !events.has(st.startEvent)) continue
    const key = stageKey(skill, st)
    // Rows without an effect still count when they end loops (kill), show a model, or fly a drawn arrow for a hit.
    if (!key && !st.effect2 && !st.kill && !isModelRow(st) && !(isFlight(st.actType) && st.dmg)) continue
    const ev = st.startEvent > 0 ? hits[st.startEvent - 1] : 0
    out.push({ stage: st, key, at: start + (ev ?? 0) })
  }
  return out
}

/** The DMG rows a hit shows: same phase and StartEvent as its cue (projectiles excluded: they land instead). */
export function damageStages(skill: FxSkill, cue: HitCueRef): FxStage[] {
  if (!hasDmgFlags(skill)) return []
  return skill.stages.filter(st => st.dmg === true && !isFlight(st.actType) && st.phase === cue.phase && st.startEvent === cue.event)
}

/** Imbues (SKILLS.md §7.2) loop their ACT_L on `Bip01 R Finger2`. */
export function isImbue(skill: FxSkill): boolean {
  return skill.stages.some(st => st.phase === 'ACT_L' && /finger2/i.test(st.startBone ?? ''))
}

/** The first damage flight of a group at or after `event` (for timing a hit on its arrival), or null. */
export function damageFlight(skill: FxSkill, phase = 'SHOT'): FxStage | null {
  return skill.stages.find(st => st.phase === phase && isFlight(st.actType) && st.dmg === true) ?? null
}

function statusPoint(view: EntityView, at: 'head' | 'body' | 'waist' | 'feet'): V3 {
  const r = view.root.position
  const h = view.height
  const y = at === 'head' ? h + 0.15 : at === 'body' ? h * 0.55 : at === 'waist' ? h * 0.35 : 0
  return [r.x, r.y + y, r.z]
}

/** Effects on a body scale with it (a giant mob's stun stars), within reason. */
function bodyScale(view: EntityView): number {
  return Math.max(0.7, Math.min(2.5, view.height / 1.8))
}

/** What SkillFx plays: an FxInstance, a model, or a drawn streak. */
interface Playable {
  update(dt: number): void
  stop(): void
  readonly finished: boolean
  dispose(): void
  /** Opacity multiplier, when the playable supports one (FxInstance). */
  fade?: number
}

/** Arrow shaft in flight when its model is missing: a pale streak behind the head; gone once stopped. */
class ArrowStreak implements Playable {
  private readonly streak: FxStreak
  private stopped = false

  constructor(scene: Scene, private readonly head: () => { pos: V3; dir: V3 }) {
    this.streak = new FxStreak(scene, 'fx:arrow')
  }

  update(): void {
    if (this.stopped) return this.streak.hide()
    const { pos, dir } = this.head()
    const tail: V3 = [pos[0] - dir[0] * 1.1, pos[1] - dir[1] * 1.1, pos[2] - dir[2] * 1.1]
    this.streak.set(tail, pos, 0.09, [1, 0.85, 0.55, 0], [1, 0.97, 0.85, 0.95])
  }

  stop(): void {
    this.stopped = true
    this.streak.hide()
  }

  get finished(): boolean {
    return this.stopped
  }

  dispose(): void {
    this.streak.dispose()
  }
}

interface Live {
  fx: Playable
  /** Local ms: stop emitting / dispose at the latest. */
  stopAt: number
  disposeAt: number
  stopped?: boolean
  owner: number | null
  loop: boolean
  /** Local ms it started. */
  born: number
  /** Skilleffect row ID (Kill / Trade name it); undefined = v1 data. */
  rowId?: number
  /** Fade-in / fade-out ms of its row (0 = none; out -1 = keep). */
  fadeIn: number
  fadeOut: number
  /** Local ms emission stopped (fade-out start). */
  stoppedAt?: number
  /** A hit effect of a fight the own character is not in (counted against `otherHitsMax`). */
  other?: boolean
}

/** A projectile: its instances (effect, arrow model) move from the caster to the target; `arrive` plays the impact. */
interface Flight {
  caster: number
  target: number
  t0: number
  t1: number
  /** Latest arrival: a damage projectile waits for its hit until then. */
  deadline: number
  waitHit: boolean
  arrivedAt: number | null
  /** Flies on past its target (its hits play as they come; it ends at t1). */
  pierce: boolean
  lives: Live[]
  arrive: () => void
}

/** A loop handle's instances (buff ACT_L, status) and what plays when it ends. */
interface LoopSet {
  owner: number
  group?: string
  lives: Live[]
  end?: () => void
}

interface SpawnOptions {
  pose: () => FxRootPose
  owner: number | null
  loop: boolean
  until: number
  scale?: number
  rowId?: number
  fade?: { inMs: number; outMs: number }
  /** A caster stage loop: when its program (or model) is still loading, a stopCasterLoops / forget of its owner in
   *  the meantime cancels it, so it never starts (the loop of a cast cancelled during the first load of its program). */
  guard?: boolean
  /** A hit effect of a fight the own character is not in (G-11: counted against the preset's `otherHits` cap). */
  other?: boolean
}

export interface StageContext {
  caster: EntityView
  target?: EntityView
  /** Local ms of the phase start and the phase's clip hit events (ms from the clip start). */
  start: number
  hits: readonly number[]
  /** Local ms when AT_LOOP stages of this phase stop. */
  loopUntil: number
  /** Only rows with these StartEvents (chain segments). */
  events?: ReadonlySet<number>
  /** The attacker's imbue group (imbued arrows). */
  imbue?: string | null
}

/** What `hit()` knows of a shown hit. */
export interface HitOptions {
  attacker?: EntityView
  cue?: HitCueRef
  index?: number
  /** A hit or crit (sparks, blood, lights play only for those). */
  landed: boolean
  /** A basic attack (bow: an arrow flies first). */
  basic?: boolean
  /** The skill instance: caster-anchored DMG rows play once per (instance, cue). */
  instance?: number
  /** The hit's outcome ('block' plays the block effect). */
  outcome?: string
  /** The victim is knocked down (the `_down` blood). */
  down?: boolean
  /** Berserk hit (CombatHit.hwan, wave 8): the HWAN DamageEfp. */
  hwan?: boolean
}

export interface SkillFxOptions {
  /** Effect library (tests pass one with registered programs). */
  library?: FxLibrary
  /** Loads `.bsr` object models (tests pass a fake). */
  modelLoader?: FxModelLoader
  /** Hit lights (default on; tests may turn them off). */
  lights?: boolean
  /**
   * Perf audit (docs/PERF_AUDIT.md): pooled batch meshes per kind of effect batch (FxLibrary.poolLimit; 0 = none, the
   * default, so an ended effect leaves no mesh behind). The world passes FX_BATCH_POOL.
   */
  batchPool?: number
}

/** The world's batch pool per (material, kind, geometry): a 50-fighter crowd keeps ≈ 100 hidden meshes at most. */
export const FX_BATCH_POOL = 8

export interface SkillFxStats {
  /** Instances playing (effects, models, streaks). */
  live: number
  /** Stages waiting for their time. */
  pending: number
  flights: number
  loops: number
  /** Weapon trails alive (drawing or emitting). */
  trails: number
  /** Instances started and disposed since construction. */
  started: number
  disposed: number
  /** Live hit effects of fights the own character is not in, and the hits skipped for the cap (G-11). */
  otherLive: number
  otherSkipped: number
  /** Swings of other characters drawn without a trail for the trail cap (G1 rescue). */
  otherTrailsSkipped: number
}

interface Swing {
  trail: WeaponTrail
  view: EntityView
  /** Follow the top clip of the actor until it changes (basic attacks), from this local ms. */
  follow: { since: number; clip: string | null } | null
  /** Local ms the trail went idle (it is kept a while for the next swing), or null while drawing. */
  idleSince: number | null
}

export class SkillFx {
  private readonly lib: FxLibrary
  private readonly ownsLib: boolean
  private skills = new Map<string, FxSkill>()
  private chars: CharacterIndex = new Map()
  private lightRows = new Map<string, FxLight>()
  private live: Live[] = []
  private pending: { at: number; owner: number | null; run: () => void }[] = []
  private flights: Flight[] = []
  private readonly failed = new Set<string>()
  private readonly programs = new Map<string, FxEffect>()
  private readonly loading = new Map<string, Promise<FxEffect | null>>()
  private readonly preloaded = new Set<string>()
  private disposed = false
  /** Loops per (carrier, key) handle: buff ACT_L, imbue loops, statuses. */
  private readonly loops = new Map<string, LoopSet>()
  /** Caster stage loops whose program is still loading (SpawnOptions.guard), cancelled by stopCasterLoops / forget. */
  private readonly loadingLoops = new Set<{ owner: number; cancelled: boolean }>()
  /** Priority groups each entity carries (imbues, Berserk): trails and DamageEfp. */
  private readonly carried = new Map<number, Map<string, string>>()
  /** Caster-anchored DMG rows already played: `${caster}:${instance}:${phase}:${event}` -> local ms. */
  private readonly dmgPlayed = new Map<string, number>()
  private readonly swings = new Map<number, Swing>()
  /** Weapon trails on (the graphics preset; world/fx/quality.ts). */
  private trailsOn = true
  /** Hits shown before their damage projectile launched: `caster>target` -> local ms (fly() consumes them). */
  private readonly earlyHits = new Map<string, number>()
  private readonly models: FxModels
  private readonly hitLights: HitLights | null
  private statusSource: StatusSource | null = null
  private started = 0
  private ended = 0
  private warnedTrail = new Set<number>()
  /** G-11 (WAVE_PLAN7 §5.5 G1): hit effects of fights the own character is not in, live at once at most. */
  private otherHitsMax = Infinity
  private otherLive = 0
  private otherSkipped = 0
  /** G1 rescue: weapon trails of other characters drawing at once, at most (world/fx/quality.ts `otherTrails`). */
  private otherTrailsMax = Infinity
  private otherTrailsSkipped = 0
  private isSelf: (id: number) => boolean = () => false
  /** Lab hook (docs/EFFECTS.md §2.5 H2): every effect, model and trail that starts. */
  onSpawn?: (e: FxLabEntry) => void

  constructor(private readonly scene: Scene, private readonly now: () => number = () => performance.now(), opts: SkillFxOptions = {}) {
    this.lib = opts.library ?? new FxLibrary(scene, OUT)
    this.ownsLib = !opts.library
    this.batchPool = Math.max(0, opts.batchPool ?? 0)
    this.models = new FxModels(scene, opts.modelLoader)
    this.hitLights = opts.lights === false ? null : new HitLights(scene, now)
  }

  async load(url = `${OUT}fx/skills.json`): Promise<void> {
    try {
      const res = await fetch(url, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (this.disposed) return
      this.setIndex(json)
    } catch (err) {
      console.warn('[skills] /out/fx/skills.json unavailable; skill effects are off', err)
    }
  }

  /** Sets the whole index (skills, characters, lights) from its JSON. */
  setIndex(json: unknown): void {
    this.skills = readFxSkills(json)
    this.chars = readCharacters(json)
    this.lightRows = readLights(json)
    for (const k of ['hiteffect/hit_2_redblood.efp', 'hiteffect/hit_3_normal.efp', BLOCK_FX]) void this.program(k)
    void this.models.preload(BASIC_ARROW.glb)
  }

  /** Sets the index directly (tests, tools). */
  setSkills(skills: Map<string, FxSkill>, characters?: CharacterIndex, lights?: ReadonlyMap<string, FxLight>): void {
    this.skills = skills
    if (characters) this.chars = characters
    if (lights) this.lightRows = new Map(lights)
  }

  skill(group: string): FxSkill | undefined {
    return this.skills.get(group)
  }

  character(code: string): FxCharacterInfo | undefined {
    return this.chars.get(code)
  }

  /** Where the mob status visuals come from (the model sidecars' particle sets). */
  setStatusSource(src: StatusSource | null): void {
    this.statusSource = src
  }

  /** Hit lights on or off (graphics quality below "medium" turns them off). */
  setLightsEnabled(on: boolean): void {
    this.hitLights?.setEnabled(on)
  }

  /** Weapon trails on or off (the graphics preset, world/fx/quality.ts); off also clears the live ribbons. */
  setTrailsEnabled(on: boolean): void {
    if (this.trailsOn === on) return
    this.trailsOn = on
    if (!on) for (const s of this.swings.values()) s.trail.disarm(this.now())
  }

  /**
   * G-11 (WAVE_PLAN7 §5.5 G1, the 20-player boss fight): the hit effects (DMG rows, sparks, blood, the hit light) of
   * fights the own character is not in are capped at `max` live at once (world/fx/quality.ts `otherHits`; Infinity: no
   * cap); a hit over the cap shows its numbers and sounds, not its effects. Hits by or on the own character always play.
   */
  setOtherHits(max: number, isSelf?: (id: number) => boolean): void {
    this.otherHitsMax = max >= 0 ? max : Infinity
    if (isSelf) this.isSelf = isSelf
  }

  /**
   * G1 rescue (WAVE_PLAN7 §5.5 G1, the 20-player boss fight): weapon trails of other characters drawing at once, at
   * most (world/fx/quality.ts `otherTrails`; Infinity: no cap). A swing over the cap draws no ribbon (the clip, the hit
   * and its sound play); the own character's swings always draw.
   */
  setOtherTrails(max: number): void {
    this.otherTrailsMax = max >= 0 ? max : Infinity
  }

  get stats(): SkillFxStats {
    return {
      live: this.live.length,
      pending: this.pending.length,
      flights: this.flights.length,
      loops: this.loops.size,
      trails: this.swings.size,
      started: this.started,
      disposed: this.ended,
      otherLive: this.otherLive,
      otherSkipped: this.otherSkipped,
      otherTrailsSkipped: this.otherTrailsSkipped,
    }
  }

  /** Hit lights flashing now (tests). */
  get lightsActive(): number {
    return this.hitLights?.active ?? 0
  }

  /** Schedules the stage rows of `phase` (READY/WAIT/SHOT/ACT_S) of `group`; DMG rows wait for `hit()`. */
  stages(group: string, phase: string, ctx: StageContext): void {
    const skill = this.skills.get(group)
    if (!skill) return
    this.preload(skill)
    for (const s of scheduleStages(skill, phase, ctx.start, ctx.hits, ctx.events)) {
      this.later(s.at, ctx.caster.id, () => this.playStage(skill, s.stage, s.key, ctx))
    }
  }

  /**
   * The weapon trail of `group` on `view` (M1): from now until local ms `until`, or, without it, while the actor's
   * current attack clip plays (basic attacks). The highest-priority group the attacker carries (imbue 2, Berserk 10)
   * replaces the row's trail; rows without a trail (bows, forces) draw none.
   */
  swing(view: EntityView, group: string, until?: number): void {
    if (this.disposed || view.isDisposed || view.dead) return
    // a seal weapon's own swing (docs/RARITY.md §5.4): its ribbon, sweep or thrust, whatever the trail settings
    if (view.actor?.weaponRarity) rarityFxOf(this.scene)?.swing(view.actor, until === undefined ? RARE_SWING_S : Math.max(0.15, (until - this.now()) / 1000))
    if (!this.trailsOn) return
    const base = this.skills.get(group)
    if (!trailStyle(base?.trail)) return
    const style = this.trailOf(view.id, base!, view.actor?.weaponRarity ?? null)
    if (!style) return
    const tip = view.actor?.weaponDummy('ai_end')
    if (!tip || !view.actor?.weaponDummy('ai_start')) {
      if (view.actor && !this.warnedTrail.has(view.id)) {
        this.warnedTrail.add(view.id)
        console.warn('[skills] no trail dummies on the weapon of', view.id)
      }
      return
    }
    const now = this.now()
    let s = this.swings.get(view.id)
    if (this.otherTrailsMax !== Infinity && !this.isSelf(view.id) && (!s || s.idleSince !== null || s.trail.isDisposed)) {
      // G1 rescue: an other character's new swing waits for a free place among the drawing ones.
      let drawing = 0
      for (const x of this.swings.values()) if (x !== s && x.idleSince === null && !x.trail.isDisposed && !this.isSelf(x.view.id)) drawing++
      if (drawing >= this.otherTrailsMax) {
        this.otherTrailsSkipped++
        return
      }
    }
    if (!s || s.trail.isDisposed) {
      const trail = new WeaponTrail(this.scene, () => this.blade(view), url => this.lib.texture(url), `fx:trail:${view.id}`)
      s = { trail, view, follow: null, idleSince: null }
      this.swings.set(view.id, s)
      this.started++
    }
    s.follow = until === undefined ? { since: now, clip: null } : null
    s.trail.arm(style, until ?? now + SWING_CAP_MS)
    this.lab({ t: now, kind: 'trail', name: group, key: style.texture ?? undefined, entity: view.id })
  }

  /**
   * The trail style `view` swings with for `skill`: its carried priority group's, else the row's; a seal weapon
   * (docs/RARITY.md §5.4) colours the row's trail in its tier (an imbue or Berserk still wins).
   */
  private trailOf(id: number, skill: FxSkill, rarity: RarityTier | null = null): TrailStyle | null {
    const top = this.carriedTop(id, g => !!trailStyle(g.trail))
    const style = trailStyle((top ?? skill).trail)
    // The Berserk makeover (docs/EFFECTS.md §3.9): the HWAN trail burns fire-orange and lasts longer.
    if (style && top?.group === HWAN_GROUP) return fireTrail(style)
    return style && !top && rarity ? rarityTrail(style, rarity) : style
  }

  /** The highest-priority group `id` carries (that passes `ok`). */
  private carriedTop(id: number, ok: (g: FxSkill) => boolean): FxSkill | null {
    let best: FxSkill | null = null
    for (const group of this.carried.get(id)?.values() ?? []) {
      const g = this.skills.get(group)
      if (g && ok(g) && (!best || (g.priority ?? 0) > (best.priority ?? 0))) best = g
    }
    return best
  }

  /** The imbue group `id` carries now, or null. */
  imbueOf(id: number): string | null {
    return this.carriedTop(id, g => isImbue(g))?.group ?? null
  }

  /** Berserk (hwan) on or off on `id` (wave 8 BZ calls it): its trail wins (priority 10). */
  setBerserk(id: number, on: boolean): void {
    this.carry(id, 'hwan', on ? HWAN_GROUP : null)
  }

  private carry(id: number, handle: string, group: string | null): void {
    let m = this.carried.get(id)
    if (group) {
      if (!m) this.carried.set(id, (m = new Map()))
      m.set(handle, group)
    } else if (m) {
      m.delete(handle)
      if (!m.size) this.carried.delete(id)
    }
  }

  private blade(view: EntityView): { tip: V3; hilt: V3 } | null {
    if (view.isDisposed || !view.actor) return null
    const a = view.actor.weaponDummy('ai_end')
    const b = view.actor.weaponDummy('ai_start')
    if (!a || !b || !view.actor.weaponVisible) return null
    const ma = a.computeWorldMatrix(true).m
    const mb = b.computeWorldMatrix(true).m
    return { tip: [ma[12]!, ma[13]!, ma[14]!], hilt: [mb[12]!, mb[13]!, mb[14]!] }
  }

  /**
   * Hit `index` of a skill's combat is shown now: its projectile lands, its DMG rows play (cue = the skill's
   * `hitCues[index]`), then the impact (spark, blood, defense, imbue, light) on the victim when it `landed`. A bow
   * basic attack (`basic`) flies an arrow first and shows the impact when it arrives.
   */
  hit(group: string, victim: EntityView | undefined, o: HitOptions): void {
    if (this.disposed || !victim || victim.isDisposed) return
    const skill = this.skills.get(group)
    if (!skill) return
    const attacker = o.attacker && !o.attacker.isDisposed ? o.attacker : undefined
    // G-11: a fight the own character is not in shows its hit effects up to the preset's cap
    const other = this.otherHitsMax !== Infinity && !this.isSelf(victim.id) && !(attacker && this.isSelf(attacker.id))
    const over = other && this.otherLive >= this.otherHitsMax
    if (over) this.otherSkipped++
    if (attacker && this.land(attacker.id, victim.id)) {
      if (!over) this.impact(skill, victim, attacker, o, other)
      return
    }
    // No flight in the air yet: a damage projectile launched later this frame (or a few ms on) must not wait HOLD_MS
    // for a hit that has already been shown; it lands on its own when it arrives (FX lab: Cold wave - Arrest).
    if (attacker && skill.stages.some(st => st.dmg && isFlight(st.actType))) this.earlyHits.set(`${attacker.id}>${victim.id}`, this.now())
    if (o.basic && attacker && attacker !== victim && skill.arrowTail && !skill.stages.length) {
      this.arrow(skill, attacker, victim, o)
      return
    }
    if (over) return
    if (o.landed) {
      const cue = o.cue ?? { phase: 'SHOT', event: (o.index ?? 0) + 1 }
      const now = this.now()
      for (const st of damageStages(skill, cue)) {
        const key = stageKey(skill, st)
        if (!key) continue
        const roll = stageRoll(st.rotate, st.script)
        const offset = parseOffset(st.startOffset)
        if (attacker && casterAnchored(st)) {
          // M8: once per cast and cue, however many victims the cue has.
          const once = `${attacker.id}:${o.instance ?? 'x'}:${cue.phase}:${cue.event}`
          if (o.instance !== undefined) {
            if (this.dmgPlayed.has(once)) continue
            this.dmgPlayed.set(once, now)
          }
          const info = infoOf(attacker, this.chars)
          this.spawn(key, {
            pose: () => {
              const rot = facing(attacker.yaw, roll)
              return { position: anchorPoint(attacker, st.startBone, offset, facing(attacker.yaw)), rotation: rot }
            },
            owner: attacker.id,
            loop: false,
            until: now + ONE_SHOT_MS,
            scale: stageScale(st.scale, attacker, info),
            ...stageFade(st),
            ...(other ? { other } : {}),
          })
        } else {
          const rot = facing(attacker?.yaw ?? victim.yaw + Math.PI, roll)
          const base = st.actType === 'AT_TARGET' ? rootPoint(victim) : damagePoint(victim, infoOf(victim, this.chars))
          const p = add(base, rotate(facing(attacker?.yaw ?? victim.yaw + Math.PI), offset))
          this.spawn(key, { pose: () => ({ position: p, rotation: rot }), owner: attacker?.id ?? null, loop: false, until: now + ONE_SHOT_MS, ...stageFade(st), ...(other ? { other } : {}) })
        }
      }
    }
    this.impact(skill, victim, attacker, o, other)
  }

  /** The hit spark (DamageEfp) of `group` on a victim, at its DamagePos (tools, fallbacks). */
  spark(group: string, victim: EntityView): void {
    const key = this.skills.get(group)?.damage
    if (!key || victim.isDisposed) return
    const p = damagePoint(victim, infoOf(victim, this.chars))
    this.spawn(key, { pose: () => ({ position: p }), owner: null, loop: false, until: this.now() + ONE_SHOT_MS })
  }

  /** What a shown hit plays on its victim (docs/EFFECTS.md §2.1 order after the DMG rows). */
  private impact(skill: FxSkill, victim: EntityView, attacker: EntityView | undefined, o: HitOptions, other = false): void {
    if (victim.isDisposed) return
    const now = this.now()
    const info = infoOf(victim, this.chars)
    const p = damagePoint(victim, info)
    const rot = facing(attacker ? attacker.yaw : victim.yaw + Math.PI)
    const at = (key: string | null | undefined, scale?: number) => {
      if (key) this.spawn(key, { pose: () => ({ position: p, rotation: rot }), owner: null, loop: false, until: now + ONE_SHOT_MS, ...(scale ? { scale } : {}), ...(other ? { other } : {}) })
    }
    if (o.outcome === 'block') {
      at(BLOCK_FX)
      victim.actor?.playOverlay?.('DEFENCE')
      return
    }
    if (!o.landed) return
    const hwan = o.hwan ? this.skills.get(HWAN_GROUP) : undefined
    at(hwan?.damage ?? skill.damage)
    if (skill.bleeds !== false && info?.bloodType) {
      const down = o.down ? info.bloodType.replace(/\.efp$/, '_down.efp') : null
      at(down && !this.failed.has(down) ? down : info.bloodType)
    }
    // M5: the DefenseEfp of the victim's highest-priority shield buff.
    const def = this.carriedDefense(victim.id)
    if (def) at(def)
    // M14: the attacker's imbue burst on every landed hit.
    const imbue = attacker ? this.carriedTop(attacker.id, g => isImbue(g)) : null
    if (imbue && imbue.group !== skill.group) at(imbue.damage)
    // M12: the light of the strongest carried row, else the attacking row's.
    const lightKey = hwan?.light ?? imbue?.light ?? skill.light
    const light = lightKey ? this.lightRows.get(lightKey) : undefined
    if (light && this.hitLights) this.hitLights.flash(p, lightColor(light), light.timeMs)
    this.lab({ t: now, kind: 'hit', name: skill.group, key: (hwan?.damage ?? skill.damage) ?? undefined, pos: p, entity: victim.id })
  }

  /** The DefenseEfp of the highest-priority buff loop `id` carries (Weak Guard of Ice, Fire Shield, ...). */
  private carriedDefense(id: number): string | null {
    let best: FxSkill | null = null
    for (const set of this.loops.values()) {
      if (set.owner !== id || !set.group) continue
      const g = this.skills.get(set.group)
      if (g?.defense && (!best || (g.priority ?? 0) > (best.priority ?? 0))) best = g
    }
    return best?.defense ?? null
  }

  /** ACT_S once on the carrier (buff lands; heal/cure/resurrect on their target at the release, M6). */
  buffStart(group: string, carrier: EntityView): void {
    this.stages(group, 'ACT_S', { caster: carrier, start: this.now(), hits: [], loopUntil: this.now() + ONE_SHOT_MS })
  }

  /** DEACT once on the carrier (a buff with a DEACT row ended, docs/EFFECTS.md §3.3). */
  buffEnd(group: string, carrier: EntityView): void {
    if (carrier.isDisposed || carrier.dead) return
    this.stages(group, 'DEACT', { caster: carrier, start: this.now(), hits: [], loopUntil: this.now() + ONE_SHOT_MS })
  }

  /** ACT_L loops on the carrier until `stopLoop(handle)`; `handle` names the effect. Imbues also swap the trail. */
  startLoop(handle: string, group: string, carrier: EntityView): void {
    const skill = this.skills.get(group)
    if (!skill || this.loops.has(handle) || this.disposed) return
    this.preload(skill)
    const set: LoopSet = { owner: carrier.id, group, lives: [] }
    this.loops.set(handle, set)
    const keep = (l: Live) => {
      if (this.loops.get(handle) === set) set.lives.push(l)
      else this.halt(l)
    }
    const info = infoOf(carrier, this.chars)
    for (const st of skill.stages) {
      if (st.phase !== 'ACT_L') continue
      const offset = parseOffset(st.startOffset)
      const roll = stageRoll(st.rotate, st.script)
      if (isModelRow(st)) {
        // White Hawk (M4): the hawk circles above the carrier while the buff lasts.
        const circle = (): FxRootPose => {
          const t = this.now() / 1000
          const a = t * 1.6
          const r = 1.2 * Math.max(0.8, info?.size ? info.size / 2 : 1)
          const c = rootPoint(carrier)
          const up = Math.max(2, offset[1])
          return { position: [c[0] + Math.sin(a) * r, c[1] + up + Math.sin(t * 2.3) * 0.12, c[2] + Math.cos(a) * r], rotation: facing(a + Math.PI / 2) }
        }
        this.spawnModel(st.objectModel!, { pose: circle, owner: carrier.id, loop: true, until: Infinity, clip: 'WALK' }, keep)
        continue
      }
      if (!st.effect) continue
      this.spawn(
        st.effect,
        {
          pose: () => {
            const rot = facing(carrier.yaw, roll)
            return { position: anchorPoint(carrier, st.startBone, offset, facing(carrier.yaw)), rotation: rot }
          },
          owner: carrier.id,
          loop: true,
          until: Infinity,
          scale: stageScale(st.scale, carrier, info),
          ...stageFade(st),
        },
        keep,
      )
    }
    if (isImbue(skill) || (skill.priority ?? 0) > 0) this.carry(carrier.id, handle, group)
  }

  /**
   * A status on `carrier` (effectAdd/effectRemove handle): its loop runs until `stopLoop(handle)`. Freeze forms its
   * ice once (`fresh`: it just started, not a spawn of someone already frozen) and breaks it when it ends. A mob plays
   * its own model's status set (docs/EFFECTS.md §3.2) at the model origin, scaled MOB_BASE; else the player file.
   */
  status(handle: string, kind: SkillStatusKind, carrier: EntityView, fresh = true): void {
    const def = STATUS_FX[kind]
    if (!def || this.loops.has(handle) || this.disposed) return
    const set: LoopSet = { owner: carrier.id, lives: [] }
    this.loops.set(handle, set)
    const keep = (l: Live) => {
      if (this.loops.get(handle) === set) set.lives.push(l)
      else this.halt(l)
    }
    const sets = carrier.kind === 'mob' ? this.statusSource?.(carrier) : null
    const own = STATUS_SET[kind]
    const pick = (name: string | undefined, fallback: string | undefined): { key: string; own: StatusParticle | null } | null => {
      const p = name ? sets?.get(name) : undefined
      if (p && !this.failed.has(p.efp)) return { key: p.efp, own: p }
      return fallback ? { key: fallback, own: null } : null
    }
    const info = infoOf(carrier, this.chars)
    const poseOf = (own: StatusParticle | null) =>
      own
        ? (): FxRootPose => {
            const rot = facing(carrier.yaw)
            return { position: anchorPoint(carrier, own.bone, own.position, rot), rotation: rot }
          }
        : () => ({ position: statusPoint(carrier, def.at), rotation: facing(carrier.yaw) })
    const scaleOf = (own: StatusParticle | null) => (own ? mobBaseScale(info, carrier) : bodyScale(carrier))
    // Stun has no set on the Jangan mobs: their monster/ stars over the head [our rule, docs/EFFECTS.md §3.2].
    const loop = kind === 'stun' && carrier.kind === 'mob' && !this.failed.has('monster/status_bad_stun.efp') ? { key: 'monster/status_bad_stun.efp', own: null } : pick(own?.loop, def.loop)
    if (loop) this.spawn(loop.key, { pose: poseOf(loop.own), owner: carrier.id, loop: true, until: Infinity, scale: scaleOf(loop.own) }, keep)
    const on = pick(own?.on, def.on)
    if (on && fresh) this.spawn(on.key, { pose: poseOf(on.own), owner: carrier.id, loop: false, until: this.now() + ONE_SHOT_MS, scale: scaleOf(on.own) }, keep)
    const off = pick(own?.off, def.off)
    if (off) {
      set.end = () => {
        if (!carrier.isDisposed && !carrier.dead) this.spawn(off.key, { pose: poseOf(off.own), owner: carrier.id, loop: false, until: this.now() + ONE_SHOT_MS, scale: scaleOf(off.own) })
      }
    }
  }

  stopLoop(handle: string): void {
    const set = this.loops.get(handle)
    if (!set) return
    this.loops.delete(handle)
    this.carry(set.owner, handle, null)
    for (const l of set.lives) this.halt(l)
    try {
      set.end?.()
    } catch (err) {
      console.error('[skills] effect failed', err)
    }
  }

  /** Stops everything a view carries or casts (it left, or died): loops, stages not started yet, its flights, trail. */
  forget(owner: number): void {
    this.cancelLoading(owner)
    for (const [h, set] of this.loops) {
      if (set.owner !== owner && !h.startsWith(`${owner}:`)) continue
      this.loops.delete(h)
      for (const l of set.lives) this.halt(l)
    }
    this.carried.delete(owner)
    for (const l of this.live) if (l.owner === owner) this.halt(l)
    this.pending = this.pending.filter(p => p.owner !== owner)
    for (const f of this.flights) {
      if (f.caster !== owner && f.target !== owner) continue
      f.arrivedAt ??= this.now()
      f.deadline = 0
      for (const l of f.lives) this.halt(l)
    }
    this.flights = this.flights.filter(f => f.caster !== owner && f.target !== owner)
    const s = this.swings.get(owner)
    if (s) {
      s.trail.dispose()
      this.swings.delete(owner)
      this.ended++
    }
  }

  /** The caster's action ended early (castEnd, replaced): its looping stages stop and stages not started are dropped. */
  stopCasterLoops(owner: number): void {
    this.cancelLoading(owner)
    this.pending = this.pending.filter(p => p.owner !== owner)
    this.killLoops(owner)
    this.swings.get(owner)?.trail.disarm(this.now())
  }

  /** FxLibrary.poolLimit while PERF.fxPool is on (SkillFxOptions.batchPool). */
  private readonly batchPool: number

  update(dt: number): void {
    const now = this.now()
    this.lib.poolLimit = PERF.fxPool ? this.batchPool : 0
    FxLibrary.skipEmptyUploads = PERF.fxSkipEmpty
    if (this.pending.length) {
      const due = this.pending.filter(p => p.at <= now)
      if (due.length) {
        this.pending = this.pending.filter(p => p.at > now)
        due.sort((a, b) => a.at - b.at)
        for (const d of due) {
          try {
            d.run()
          } catch (err) {
            console.error('[skills] effect failed', err)
          }
        }
      }
    }
    if (this.flights.length) {
      for (const f of this.flights) {
        if (f.arrivedAt === null && now >= f.t1 && (f.pierce || !f.waitHit || now >= f.deadline)) this.arrive(f, now)
      }
      this.flights = this.flights.filter(f => f.arrivedAt === null)
    }
    this.updateSwings(now)
    this.hitLights?.update()
    if (this.dmgPlayed.size > 64) for (const [k, t] of this.dmgPlayed) if (now - t > 10_000) this.dmgPlayed.delete(k)
    if (this.earlyHits.size > 32) for (const [k, t] of this.earlyHits) if (now - t > EARLY_HIT_MS) this.earlyHits.delete(k)
    if (!this.live.length) return
    const keep: Live[] = []
    for (const l of this.live) {
      if (now >= l.stopAt && !l.stopped) {
        l.stopped = true
        l.stoppedAt = now
        l.fx.stop()
        // A row with a fade-out dissolves within it (M15).
        if (l.fadeOut > 0) l.disposeAt = Math.min(l.disposeAt, now + l.fadeOut)
      }
      if (l.fx.fade !== undefined && (l.fadeIn > 0 || l.fadeOut > 0)) {
        const fin = l.fadeIn > 0 ? Math.min(1, (now - l.born) / l.fadeIn) : 1
        const fout = l.stoppedAt !== undefined && l.fadeOut > 0 ? Math.max(0, 1 - (now - l.stoppedAt) / l.fadeOut) : 1
        l.fx.fade = fin * fout
      }
      try {
        l.fx.update(dt)
      } catch (err) {
        console.error('[skills] effect failed', err)
        l.disposeAt = 0
      }
      // A looping effect is briefly "finished" between cycles: only a stopped one is done.
      if ((l.fx.finished && (l.stopped || !l.loop)) || now >= l.disposeAt) this.drop(l)
      else keep.push(l)
    }
    this.live = keep
  }

  private updateSwings(now: number): void {
    for (const [id, s] of this.swings) {
      const v = s.view
      if (v.isDisposed) {
        s.trail.dispose()
        this.swings.delete(id)
        this.ended++
        continue
      }
      if (s.follow) {
        // Basic attacks: swing while the attack clip that started after the arm plays.
        const top = v.actor?.clipCursors().top?.name ?? null
        if (s.follow.clip === null) {
          if (top && /^(ATTACK|SKILL)/.test(top)) s.follow.clip = top
          else if (now - s.follow.since > 250) s.trail.disarm(now)
        } else if (top !== s.follow.clip || v.dead) {
          s.trail.disarm(now)
          s.follow = null
        }
      }
      s.trail.update(now)
      const idle = s.trail.idleAt(now) && !s.follow
      if (!idle) s.idleSince = null
      else s.idleSince ??= now
      // Kept for the next swing a while (attacks come every second or so), then disposed.
      if (idle && now - s.idleSince! >= TRAIL_KEEP_MS) {
        s.trail.dispose()
        this.swings.delete(id)
        this.ended++
      }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const l of this.live) this.drop(l)
    this.live = []
    this.pending = []
    this.flights = []
    this.loops.clear()
    this.carried.clear()
    for (const s of this.swings.values()) s.trail.dispose()
    this.swings.clear()
    this.hitLights?.dispose()
    this.models.dispose()
    if (this.ownsLib) this.lib.dispose()
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private lab(e: FxLabEntry): void {
    if (!this.onSpawn) return
    try {
      this.onSpawn(e)
    } catch (err) {
      console.warn('[skills] onSpawn failed', err)
    }
  }

  /** Loads a group's effects and models ahead of their stages (once per group). */
  private preload(skill: FxSkill): void {
    if (this.preloaded.has(skill.group)) return
    this.preloaded.add(skill.group)
    const keys = new Set<string>()
    for (const k of [skill.damage, skill.arrowTail, skill.arrowForce, skill.defense]) if (k) keys.add(k)
    for (const st of skill.stages) {
      for (const k of [st.effect, st.effect2]) if (k) keys.add(k)
      if (st.objectModel?.glb) void this.models.preload(st.objectModel.glb)
    }
    for (const k of keys) void this.program(k)
  }

  private program(key: string): Promise<FxEffect | null> {
    let p = this.loading.get(key)
    if (!p) {
      p = this.lib.load(key).then(
        e => {
          this.programs.set(key, e)
          return e
        },
        err => {
          if (!this.failed.has(key)) console.warn('[skills] effect unavailable', key, err)
          this.failed.add(key)
          return null
        },
      )
      this.loading.set(key, p)
    }
    return p
  }

  private drop(l: Live): void {
    if (l.other) {
      l.other = false
      this.otherLive--
    }
    l.fx.dispose()
    this.ended++
  }

  /** Stops emission now; whatever is alive fades out within FADE_MS (its row's fade-out when it has one). */
  private halt(l: Live): void {
    l.stopAt = 0
    l.disposeAt = Math.min(l.disposeAt, this.now() + (l.fadeOut > 0 ? l.fadeOut : FADE_MS))
  }

  /** Removes an instance at once (a Trade flight took it over: one instance, not two). */
  private take(l: Live): void {
    l.stopAt = 0
    l.disposeAt = 0
    l.fx.stop()
  }

  /**
   * Ends a caster's looping stages (not its buff/status loops): those with row ID `id` when given (Kill, M15),
   * those started before `before` when given.
   */
  private killLoops(owner: number, before = Infinity, id?: number): void {
    for (const l of this.live) {
      if (l.owner !== owner || !l.loop || l.born >= before || this.inLoopSet(l)) continue
      if (id !== undefined && l.rowId !== undefined && l.rowId !== id) continue
      this.halt(l)
    }
  }

  private inLoopSet(l: Live): boolean {
    for (const set of this.loops.values()) if (set.lives.includes(l)) return true
    return false
  }

  private later(at: number, owner: number | null, run: () => void): void {
    if (at <= this.now()) run()
    else this.pending.push({ at, owner, run })
  }

  /** Lands the oldest projectile from `caster` at `target` still in the air (a damage one first). */
  private land(caster: number, target: number): boolean {
    const mine = this.flights.filter(f => f.caster === caster && f.arrivedAt === null && (f.target === target || f.pierce))
    const f = mine.find(x => x.waitHit && x.target === target) ?? mine.find(x => x.target === target) ?? mine[0]
    if (!f) return false
    // A piercing arrow keeps flying: the victim's impact plays as it passes.
    if (!f.pierce) this.arrive(f, this.now())
    return true
  }

  private arrive(f: Flight, now: number): void {
    if (f.arrivedAt !== null) return
    f.arrivedAt = now
    for (const l of f.lives) {
      l.stopAt = 0
      l.disposeAt = Math.min(l.disposeAt, now + FADE_MS)
    }
    try {
      f.arrive()
    } catch (err) {
      console.error('[skills] effect failed', err)
    }
  }

  /**
   * Starts a projectile now: `from` -> `to()` over the distance at `speed` m/s (arcing `lift` m at the middle),
   * carrying `key` (the effect or arrow tail), the arrow `model` (nose along the flight) or a drawn streak when the
   * model is missing, and the arrow `force` effect on its head; `arrive` plays when it lands.
   */
  private fly(o: {
    caster: EntityView
    target: EntityView
    key: string | null
    model?: FxModelRef | null
    force?: string | null
    streak?: boolean
    from: V3
    to: () => V3
    speed: number
    lift: number
    pierce?: boolean
    waitHit: boolean
    scale?: number
    arrive: () => void
  }): Flight {
    const now = this.now()
    let to = o.to
    if (o.pierce) {
      // Past the target on the same line (M16).
      const end = o.to()
      const d = Math.max(0.01, dist(o.from, end))
      const dir = scaleV([end[0] - o.from[0], end[1] - o.from[1], end[2] - o.from[2]], 1 / d)
      const far = add(end, scaleV(dir, PIERCE_M))
      to = () => far
    }
    const d = dist(o.from, to())
    const early = `${o.caster.id}>${o.target.id}`
    const hitFirst = o.waitHit && now - (this.earlyHits.get(early) ?? -Infinity) <= EARLY_HIT_MS
    if (hitFirst) this.earlyHits.delete(early)
    const f: Flight = {
      caster: o.caster.id,
      target: o.target.id,
      t0: now,
      t1: now + Math.min(MAX_FLIGHT_MS, (d / Math.max(1, o.speed)) * 1000),
      deadline: 0,
      waitHit: o.waitHit && !hitFirst,
      arrivedAt: null,
      pierce: !!o.pierce,
      lives: [],
      arrive: o.arrive,
    }
    f.deadline = f.t1 + HOLD_MS
    const lift = o.lift
    const at = (): { pos: V3; dir: V3 } => {
      const t = this.now()
      const k = f.arrivedAt !== null ? 1 : Math.max(0, Math.min(1, (t - f.t0) / Math.max(1, f.t1 - f.t0)))
      const b = to()
      const pos = lerp(o.from, b, k)
      pos[1] += lift * 4 * k * (1 - k)
      // Direction of travel (the arc's tangent).
      const dy = lift * 4 * (1 - 2 * k)
      const flat = Math.max(1e-6, dist(o.from, b))
      const dir: V3 = [(b[0] - o.from[0]) / flat, (b[1] - o.from[1] + dy) / flat, (b[2] - o.from[2]) / flat]
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
      return { pos, dir: [dir[0] / l, dir[1] / l, dir[2] / l] }
    }
    const until = f.t1 + HOLD_MS + ONE_SHOT_MS
    const track = (l: Live) => {
      if (f.arrivedAt !== null) this.halt(l)
      f.lives.push(l)
    }
    const head = (): FxRootPose => {
      const { pos, dir } = at()
      return { position: pos, rotation: lookAlong(dir) }
    }
    if (o.key) this.spawn(o.key, { pose: head, owner: o.caster.id, loop: false, until, ...(o.scale ? { scale: o.scale } : {}) }, track)
    if (o.force) this.spawn(o.force, { pose: head, owner: o.caster.id, loop: false, until }, track)
    let drawn = false
    if (o.model) {
      // The arrow's nock is its origin and the tip lies along +Z: the tip leads the flight point.
      drawn = this.spawnModel(o.model, {
        pose: () => {
          const { pos, dir } = at()
          return { position: add(pos, scaleV(dir, -0.9 * (o.scale ?? 1))), rotation: lookAlong(dir) }
        },
        owner: o.caster.id,
        loop: false,
        until,
        scale: o.scale,
      }, track)
    }
    if (!drawn && (o.streak || o.model)) track(this.add(new ArrowStreak(this.scene, at), { owner: o.caster.id, loop: false, until }))
    // a seal bow's arrow flies as a shooting star, a moon-bolt or a sunfire comet (docs/RARITY.md §5.4)
    if (o.caster.actor?.weaponRarity) rarityFxOf(this.scene)?.arrow(o.caster.actor, at, () => f.arrivedAt !== null)
    this.flights.push(f)
    return f
  }

  /** Bow basic attack: an arrow from the drawing hand to the victim; the impact shows when it arrives. */
  private arrow(skill: FxSkill, attacker: EntityView, victim: EntityView, o: HitOptions | null): Flight {
    const from = anchorPoint(attacker, 'Bip01 R Hand', [0, 0, 0], facing(attacker.yaw))
    const to = () => flightEnd(victim, parseOffset('0,10,0'), infoOf(victim, this.chars))
    const d = dist(from, to())
    return this.fly({
      caster: attacker,
      target: victim,
      key: skill.arrowTail,
      model: arrowModel(BASIC_ARROW, this.imbueOf(attacker.id)),
      force: skill.arrowForce,
      from,
      to,
      speed: ARROW_SPEED,
      lift: Math.min(1.5, d * 0.04),
      // Released ahead of its hit (shootBasic): it waits at the victim for `hit`, which shows the impact.
      waitHit: o === null,
      arrive: () => {
        if (o && !victim.isDisposed) this.impact(skill, victim, attacker, o)
      },
    })
  }

  /**
   * A bow basic attack released now (its clip's hit event): the arrow flies from the drawing hand and waits at the
   * victim for its `hit`, which lands it and shows the impact. Returns the flight time (ms) the hit should be shown
   * after, or null when the group flies no basic arrow (melee weapons, or the data is not loaded yet).
   */
  shootBasic(group: string, attacker: EntityView, victim: EntityView): number | null {
    if (this.disposed || attacker.isDisposed || victim.isDisposed || attacker === victim) return null
    const skill = this.skills.get(group)
    if (!skill?.arrowTail || skill.stages.length) return null
    const f = this.arrow(skill, attacker, victim, null)
    return f.t1 - f.t0
  }

  private playStage(skill: FxSkill, st: FxStage, key: string | null, ctx: StageContext): void {
    const { caster, target } = ctx
    if (caster.isDisposed) return
    const offset = parseOffset(st.startOffset)
    const roll = stageRoll(st.rotate, st.script)
    const now = this.now()
    const info = infoOf(caster, this.chars)
    const scale = stageScale(st.scale, caster, info)
    // Kill rows end the caster's loops with their ID (M15; v1 data: every loop of the phases before).
    if (st.kill) this.killLoops(caster.id, ctx.start, st.id === undefined ? undefined : st.kill)
    if (isFlight(st.actType)) {
      if (!target || target.isDisposed) return
      const move = parseMove(st.move) ?? { delayMs: 0, speed: 30 }
      const launch = () => {
        if (caster.isDisposed || target.isDisposed) return
        const from = anchorPoint(caster, st.startBone, offset, facing(caster.yaw))
        const tinfo = infoOf(target, this.chars)
        const toOffset = parseOffset(st.targetOffset)
        const to = () => flightEnd(target, toOffset, tinfo)
        const d = dist(from, to())
        // Trade (M15): the flight takes over the caster's live loop with that ID (the nocked arrow leaves the hand).
        if (st.trade) for (const l of this.live) if (l.owner === caster.id && l.loop && l.rowId === st.trade && !this.inLoopSet(l)) this.take(l)
        const model = isModelRow(st) ? arrowModel(st.objectModel, ctx.imbue) : null
        const lift = arcs(st.move) ? (st.param?.[0] ? st.param[0] * 0.1 : Math.min(3, d * 0.12)) * Math.min(1, d / 10) : 0
        this.fly({
          caster,
          target,
          key: st.effect ?? (model ? skill.arrowTail : key),
          model,
          force: model ? skill.arrowForce : null,
          streak: !st.effect && /\.bsr$/i.test(st.object ?? '.bsr'),
          from,
          to,
          speed: move.speed,
          lift,
          pierce: pierces(st.move),
          waitHit: st.dmg === true,
          ...(st.scale === 'MOB_BASE' ? { scale } : {}),
          arrive: () => {
            if (st.effect2 && !target.isDisposed) {
              const p = to()
              this.spawn(st.effect2, { pose: () => ({ position: p }), owner: null, loop: false, until: this.now() + ONE_SHOT_MS })
            }
          },
        })
      }
      if (move.delayMs > 0) this.later(now + move.delayMs, caster.id, launch)
      else launch()
      return
    }
    switch (st.actType) {
      case 'AT_DMG_POS':
      case 'AT_TARGET': {
        if (!target || target.isDisposed) return
        const move = st.actType === 'AT_TARGET' ? parseMove(st.move) : null
        const rot0 = facing(caster.yaw)
        if (move) {
          // Falls from its start offset over the target to its target offset (meteors, ice spikes).
          const base = target.root.position
          const from = rotate(rot0, offset)
          const to = rotate(rot0, parseOffset(st.targetOffset))
          const launch = () => {
            if (target.isDisposed) return
            const origin: V3 = [base.x, base.y, base.z]
            this.fly({
              caster,
              target,
              key,
              from: add(origin, from),
              to: () => add(origin, to),
              speed: move.speed,
              lift: 0,
              waitHit: false,
              arrive: () => {
                if (!st.effect2) return
                const p = add(origin, to)
                this.spawn(st.effect2, { pose: () => ({ position: p }), owner: null, loop: false, until: this.now() + ONE_SHOT_MS })
              },
            })
          }
          if (move.delayMs > 0) this.later(now + move.delayMs, caster.id, launch)
          else launch()
          return
        }
        if (!key) return
        const base = st.actType === 'AT_TARGET' ? rootPoint(target) : damagePoint(target, infoOf(target, this.chars))
        const p = add(base, rotate(rot0, offset))
        const rot = facing(caster.yaw, roll)
        this.spawn(key, { pose: () => ({ position: p, rotation: rot }), owner: caster.id, loop: false, until: now + ONE_SHOT_MS, ...stageFade(st) })
        return
      }
      default: {
        const loop = st.actType === 'AT_LOOP'
        if (isModelRow(st)) {
          // A model on the caster's bone (the nocked arrow, M2): nock at the drawing hand, tip towards the bow hand.
          const model = arrowModel(st.objectModel, ctx.imbue)!
          const pose = (): FxRootPose => {
            const hand = anchorPoint(caster, st.startBone, offset, facing(caster.yaw))
            const bow = caster.actor?.joint('Bip01 L Hand')
            let dir = rotate(facing(caster.yaw), [0, 0, 1])
            if (bow) {
              const m = bow.computeWorldMatrix(true).m
              const d = [m[12]! - hand[0], m[13]! - hand[1], m[14]! - hand[2]] as V3
              if (Math.hypot(d[0], d[1], d[2]) > 0.15) dir = d
            }
            return { position: hand, rotation: lookAlong(dir) }
          }
          this.spawnModel(model, { pose, owner: caster.id, loop, until: loop ? ctx.loopUntil : now + ONE_SHOT_MS, rowId: st.id, scale: st.scale === 'MOB_BASE' ? scale : undefined, guard: true })
          return
        }
        if (!key) return
        const pose = (): FxRootPose => {
          const rot = facing(caster.yaw, roll)
          return { position: anchorPoint(caster, st.startBone, offset, facing(caster.yaw)), rotation: rot }
        }
        this.spawn(key, { pose, owner: caster.id, loop, until: loop ? ctx.loopUntil : now + ONE_SHOT_MS, scale, rowId: st.id, ...stageFade(st), guard: true })
      }
    }
  }

  /** Plays `key` (synchronously once its program is loaded); `then` gets the instance. */
  private spawn(key: string, o: SpawnOptions, then?: (l: Live) => void): void {
    if (this.disposed || this.failed.has(key)) return
    // G-11: an others' hit effect holds its place under the cap from now (its program may still be loading) until
    // its instance ends (drop), or at once when it never starts
    if (o.other) this.otherLive++
    const started = (l: Live | null) => {
      if (!l && o.other) this.otherLive--
    }
    const ready = this.programs.get(key)
    if (ready) {
      const l = this.start(ready, o)
      started(l)
      if (l) then?.(l)
      return
    }
    const token = this.guardLoad(o)
    void this.program(key).then(effect => {
      if (!this.loadDone(token) || !effect) return started(null)
      const l = this.start(effect, o)
      started(l)
      if (l) then?.(l)
    }, () => started(null))
  }

  /** A guarded caster loop that must wait for its program: its cancel token (null = not guarded). */
  private guardLoad(o: SpawnOptions): { owner: number; cancelled: boolean } | null {
    if (!o.guard || !o.loop || o.owner === null) return null
    const token = { owner: o.owner, cancelled: false }
    this.loadingLoops.add(token)
    return token
  }

  /** The load of a guarded loop finished: false when its owner's loops were stopped meanwhile. */
  private loadDone(token: { owner: number; cancelled: boolean } | null): boolean {
    if (!token) return true
    this.loadingLoops.delete(token)
    return !token.cancelled
  }

  /** Cancels the guarded loops of `owner` that are still loading. */
  private cancelLoading(owner: number): void {
    for (const t of this.loadingLoops) {
      if (t.owner !== owner) continue
      t.cancelled = true
      this.loadingLoops.delete(t)
    }
  }

  private start(effect: FxEffect, o: SpawnOptions): Live | null {
    if (this.disposed || this.now() > o.until) return null
    // M22: a one-shot program gets its own length (+ the tail) when it is longer than the default cap.
    let until = o.until
    if (!o.loop && effect.duration !== null && Number.isFinite(effect.duration)) until = Math.max(until, this.now() + effect.duration * 50 + 1500)
    const fx = new FxInstance(this.lib, effect, { pose: o.pose, loop: o.loop, camera: this.lib.scene.activeCamera, ...(o.scale && o.scale !== 1 ? { scale: o.scale } : {}) })
    if (o.fade?.inMs) fx.fade = 0
    const l = this.add(fx, { ...o, until })
    if (this.onSpawn) {
      let pos: V3 | undefined
      try {
        pos = o.pose().position
      } catch {
        pos = undefined
      }
      this.lab({ t: this.now(), kind: 'fx', name: effect.key, key: effect.key, ...(pos ? { pos } : {}), entity: o.owner ?? -1 })
    }
    return l
  }

  /** Plays a `.bsr` object model (arrows, the hawk); true when it could be drawn now. */
  private spawnModel(ref: FxModelRef, o: SpawnOptions & { clip?: string }, then?: (l: Live) => void): boolean {
    if (this.disposed) return false
    const make = (): Live | null => {
      if (this.disposed || this.now() > o.until) return null
      const m: FxModelInstance | null = this.models.spawn(ref.glb, o.pose, { ...(o.clip ? { clip: o.clip } : {}), ...(o.scale ? { scale: o.scale } : {}) })
      if (!m) return null
      this.lab({ t: this.now(), kind: 'fx', name: ref.glb, key: ref.glb, entity: o.owner ?? -1 })
      return this.add(m, o)
    }
    if (this.models.ready(ref.glb)) {
      const l = make()
      if (l) then?.(l)
      return !!l
    }
    if (this.models.hasFailed(ref.glb)) return false
    const token = this.guardLoad(o)
    void this.models.preload(ref.glb).then(c => {
      if (!this.loadDone(token) || !c) return
      const l = make()
      if (l) then?.(l)
    })
    return false
  }

  private add(fx: Playable, o: { owner: number | null; loop: boolean; until: number; rowId?: number; fade?: { inMs: number; outMs: number }; other?: boolean }): Live {
    while (this.live.length >= MAX_LIVE) {
      const i = this.live.findIndex(l => !l.loop)
      const old = this.live.splice(i >= 0 ? i : 0, 1)[0]
      if (old) this.drop(old)
    }
    // Loops emit until `until`, then fade out (FADE_MS more at most); one-shots stop emitting 1.5 s before their cap.
    const l: Live = {
      fx,
      stopAt: o.loop ? o.until : o.until - 1500,
      disposeAt: o.loop ? o.until + FADE_MS : o.until,
      owner: o.owner,
      loop: o.loop,
      born: this.now(),
      fadeIn: Math.max(0, o.fade?.inMs ?? 0),
      fadeOut: Math.max(0, o.fade?.outMs ?? 0),
      ...(o.rowId !== undefined ? { rowId: o.rowId } : {}),
      // counted by spawn (G-11)
      ...(o.other ? { other: true } : {}),
    }
    this.live.push(l)
    this.started++
    return l
  }
}

/** The fade of a row for SpawnOptions (none when the row has none). */
function stageFade(st: FxStage): { fade?: { inMs: number; outMs: number } } {
  const f = st.fade
  return f && (f.inMs > 0 || f.outMs > 0) ? { fade: f } : {}
}
