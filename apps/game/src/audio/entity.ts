/**
 * Per-entity sound glue (docs/SOUND.md §5.7): polls the entity's animation clip cursors once per frame, resolves the
 * crossed clip tracks (footsteps by surface, skill swing overrides, 50 % of player shouts) and plays them at the
 * entity. Entities further than 40 m from the listener are not polled (yourself always is); coming back into range
 * only re-syncs, so skipped tracks are not replayed.
 */
import type { ClipTrack, ModelSounds, SoundHandle, SoundIndex, SoundSurface } from '@sro/shared'
import type { Vec3Like } from './backend.ts'
import { ClipSoundDriver, type ClipCursor, type ClipCursors } from './clips.ts'
import { mobAttackOf, pick, SKILL_ROWS_OVERRIDE_CLIP, trackFile } from './cues.ts'
import type { VoiceKind } from './voices.ts'

/** The slice of world/entities.ts EntityView the sound reads (structural, for tests). */
export interface SoundView {
  readonly id: number
  readonly kind: 'player' | 'mob' | 'npc' | 'item' | 'cos'
  readonly state: { readonly model: string }
  readonly root: { readonly position: Vec3Like }
  /** `movementTracks`: wave 10's synthetic take-off and landing steps of the movement clips (three/models.ts). */
  readonly actor: { clipCursors?(): ClipCursors; movementTracks?(clip: string): readonly ClipTrack[] | undefined } | null
  readonly dead: boolean
  readonly isSelf: boolean
}

/** What EntitySound needs from GameAudio (index.ts implements it). */
export interface EntitySoundHost {
  readonly index: SoundIndex | null
  /** Distance from the listener (0 before the first listener update). */
  distance(p: Vec3Like): number
  /** Surface under a point (flat fallback: Dirt). */
  surfaceAt(x: number, y: number, z: number): SoundSurface
  /**
   * Wave 10 (WAVE_PLAN6 D22): the water surface's height over (x, z) (the coast's sea, else a retail water plane; null
   * on dry ground), so a jump landing in shallow water plays the water step. Optional: absent = never water.
   */
  waterLevelAt?(x: number, z: number): number | null
  /** The model's clip tracks when loaded (starts the load on first ask). */
  modelTracks(code: string): ModelSounds | null | undefined
  priorityOf(id: number, kind: SoundView['kind'], self: boolean): number
  playFile(file: string, opts: EntityPlay): void
  rng(): number
}

export interface EntityPlay {
  entity: number
  kind: VoiceKind
  priority: number
  self: boolean
  /** Spatial source position (omitted for your own sounds). */
  pos?: Vec3Like
  /** Where a long sound follows (the entity root). */
  follow?: () => Vec3Like | null
  gain?: number
  /** Skip when this entity already plays the file. */
  unique?: boolean
}

/** Actors further than this are not polled (metres). */
export const POLL_RANGE_M = 40
/** A surface answer is reused this long per entity (ms). */
const SURFACE_CACHE_MS = 250
/** Share of player shouts that play (retail shouts on every swing; noisy with many players). */
export const PLAYER_SHOUT_SHARE = 0.5
/** A crit's hurt-clip moan is expected within this time of the hit (ms). */
const CRIT_MOAN_MS = 400
/** Delay of the body thud after the death cry when a model has no DIE1 tracks (ms). */
const FALLBACK_THUD_MS = 1500
/** Raw names of the jump's synthetic tracks (three/models.ts movementTracksOf; kept in sync by audio.test.ts). */
const JUMP_TAKEOFF_RAW = 'jump_takeoff'
const JUMP_LAND_RAW = 'jump_land'
/** The landing step plays louder: +2 dB (docs/MOVEMENT.md §6.4). */
export const JUMP_LAND_GAIN = 10 ** (2 / 20)
/** Water this deep over the ground (m) makes a jump's take-off or landing the water step (MOVEMENT §6.4). */
export const JUMP_WATER_DEPTH_M = 0.1

/** The surface of a jump step at a point: the water step where the water stands deeper than JUMP_WATER_DEPTH_M. */
export function jumpSurface(ground: SoundSurface, groundY: number, waterLevel: number | null | undefined): SoundSurface {
  return waterLevel !== null && waterLevel !== undefined && waterLevel - groundY > JUMP_WATER_DEPTH_M ? 'Water' : ground
}

export function voiceKindOf(handle: SoundHandle): VoiceKind {
  switch (handle) {
    case 'step_walk':
    case 'step_run':
      return 'step'
    case 'shout':
    case 'moan':
      return 'voice'
    case 'death_voice':
      return 'death'
    case 'idle':
    case 'emote':
      return 'idle'
    default:
      return 'other'
  }
}

export class EntitySound {
  private readonly driver: ClipSoundDriver
  private skill: { group: string; until: number } | null = null
  /** Berserk: the weapon's HWAN swing files (docs/SOUND.md §10.3); null outside it. */
  private hwanSwing: readonly string[] | null = null
  /** The mob attack clip start last seen (`name#run`), for mobAttackStart. */
  private attackKey: string | null = null
  /** Until this time (ms) the next moan track is the crit moan. */
  private critUntil = 0
  private inRange = true
  private surface: { at: number; x: number; z: number; s: SoundSurface } | null = null
  private wasDead: boolean
  private later: { at: number; file: string; kind: VoiceKind }[] = []
  private disposed = false

  constructor(private readonly host: EntitySoundHost, private readonly view: SoundView) {
    this.driver = new ClipSoundDriver(clip => host.modelTracks(view.state.model)?.clips[clip] ?? view.actor?.movementTracks?.(clip))
    this.wasDead = view.dead
  }

  /** The skill group this entity performs (swing overrides, §5.9); null clears. Expires after `forMs`. */
  setSkill(group: string | null, forMs = 4000, nowMs = performance.now()): void {
    this.skill = group ? { group, until: nowMs + forMs } : null
  }

  get currentSkill(): string | null {
    return this.skill?.group ?? null
  }

  /** A crit landed on this entity: its next hurt-clip moan is the critical one (VOC_MOAN CRITYCAL). */
  critHit(nowMs = performance.now()): void {
    this.critUntil = nowMs + CRIT_MOAN_MS
  }

  /** Berserk on (the weapon's SND_SWING3 HWAN files replace the basic swings) or off (null). */
  setHwanSwing(files: readonly string[] | null): void {
    this.hwanSwing = files?.length ? files : null
  }

  update(nowMs: number): void {
    const v = this.view
    if (this.disposed || v.kind === 'item') return
    const pos = v.root.position
    const self = v.isSelf
    if (!self && this.host.distance(pos) > POLL_RANGE_M) {
      if (this.inRange) this.driver.reset()
      this.inRange = false
      this.wasDead = v.dead
      return
    }
    const fire = this.inRange
    this.inRange = true
    if (this.skill && nowMs > this.skill.until) this.skill = null
    this.checkDeath(nowMs, fire)
    if (this.later.length) this.flushLater(nowMs)
    const cursors = v.actor?.clipCursors?.()
    if (!cursors) return
    if (v.kind === 'mob') this.mobAttackStart(cursors.top, fire)
    const fired = this.driver.update(cursors, nowMs, fire)
    if (!fired.length) return
    const index = this.host.index
    if (!index) return
    for (const track of fired) {
      if (track.handle === 'shout' && v.kind === 'player' && this.host.rng() >= PLAYER_SHOUT_SHARE) continue
      const jumpStep = track.raw === JUMP_TAKEOFF_RAW || track.raw === JUMP_LAND_RAW
      if (track.handle === 'moan' && this.critUntil > nowMs) {
        // §10.3: the hurt clip of a crit moans with the VOC_MOAN CRITYCAL row (the one GameAudio.hit just played).
        this.critUntil = 0
        const crit = pick((index.mobs[v.state.model] ?? index.voices[v.state.model])?.moan.crit, () => this.host.rng())
        if (crit) {
          this.play(crit, 'voice')
          continue
        }
      }
      const file = trackFile(index, track, {
        surface: () => (jumpStep ? this.jumpSurfaceAt(nowMs) : this.surfaceAt(nowMs)),
        skill: this.skill?.group ?? null,
        overrideSwing: SKILL_ROWS_OVERRIDE_CLIP,
        hwanSwing: this.hwanSwing,
        rng: () => this.host.rng(),
      })
      // A skill's own swing row may name its stage sound too (Heal: csk_heal_ready): play it once.
      if (file) this.play(file, voiceKindOf(track.handle), track.raw === JUMP_LAND_RAW ? JUMP_LAND_GAIN : undefined, track.handle === 'swing' && file !== track.file)
    }
  }

  dispose(): void {
    this.disposed = true
    this.later = []
  }

  /** Plays one file from this entity (non-spatial for yourself). */
  play(file: string, kind: VoiceKind, gain?: number, unique = false): void {
    const v = this.view
    const self = v.isSelf
    const root = v.root
    this.host.playFile(file, {
      entity: v.id,
      kind,
      priority: this.host.priorityOf(v.id, v.kind, self),
      self,
      pos: self ? undefined : { x: root.position.x, y: root.position.y + 1, z: root.position.z },
      follow: self ? undefined : () => (this.disposed ? null : { x: root.position.x, y: root.position.y + 1, z: root.position.z }),
      gain,
      unique,
    })
  }

  /**
   * A mob attack clip whose model carries no swing or shout track (Tombstone's force attacks, docs/SOUND.md §10.3)
   * plays the effectsound swing row of that attack (`MOB_<NAME> SND_SWING1 <MSKILL>`) when the clip starts, once per
   * start. Models with their own tracks keep them (the driver plays those).
   */
  private mobAttackStart(top: ClipCursor | null, fire: boolean): void {
    const key = top && /^ATTACK\d/.test(top.name) ? `${top.name}#${top.run}` : null
    if (key === this.attackKey) return
    this.attackKey = key
    if (!key || !top || !fire) return
    const index = this.host.index
    const code = this.view.state.model
    const model = this.host.modelTracks(code)
    if (!index || model === undefined || model?.clips[top.name]?.some(t => t.handle === 'swing' || t.handle === 'shout')) return
    const skill = mobAttackOf(index, code, top.name)
    const file = pick(skill ? index.mobs[code]?.attacks[skill]?.swing : undefined, () => this.host.rng())
    if (file) this.play(file, 'other', index.mobs[code]?.gain)
  }

  /**
   * Models without DIE1 tracks still cry out and fall (§5.9 "Death"): the mob's (or player's) effectsound death voice
   * and thud when the entity dies in view. Entities that arrive dead stay quiet.
   */
  private checkDeath(nowMs: number, fire: boolean): void {
    const dead = this.view.dead
    if (dead === this.wasDead) return
    this.wasDead = dead
    if (!dead || !fire) return
    const index = this.host.index
    const code = this.view.state.model
    const model = this.host.modelTracks(code)
    if (!index || model === undefined || model?.clips.DIE1?.length) return
    const set = index.mobs[code] ?? index.voices[code]
    if (!set) return
    const cry = pick(set.deathVoice, () => this.host.rng())
    if (cry) this.play(cry, 'death', set.gain)
    const thud = pick(set.deathThud, () => this.host.rng())
    if (thud) this.later.push({ at: nowMs + FALLBACK_THUD_MS, file: thud, kind: 'other' })
  }

  private flushLater(nowMs: number): void {
    const due = this.later.filter(l => l.at <= nowMs)
    if (!due.length) return
    this.later = this.later.filter(l => l.at > nowMs)
    for (const l of due) this.play(l.file, l.kind)
  }

  /** A jump's take-off or landing step: the ground's surface, or water where it stands over the ground (D22). */
  private jumpSurfaceAt(nowMs: number): SoundSurface {
    const p = this.view.root.position
    return jumpSurface(this.surfaceAt(nowMs), p.y, this.host.waterLevelAt?.(p.x, p.z))
  }

  private surfaceAt(nowMs: number): SoundSurface {
    const p = this.view.root.position
    const c = this.surface
    if (c && nowMs - c.at < SURFACE_CACHE_MS && Math.abs(c.x - p.x) < 1 && Math.abs(c.z - p.z) < 1) return c.s
    const s = this.host.surfaceAt(p.x, p.y, p.z)
    this.surface = { at: nowMs, x: p.x, z: p.z, s }
    return s
  }
}
