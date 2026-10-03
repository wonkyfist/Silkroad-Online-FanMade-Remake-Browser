/**
 * What models do while they stand still (docs/EFFECTS.md §3.11-§3.12, docs/WAVE_PLAN2.md D7): one IdleDriver per view,
 * hung on it as an EntityAttachment by the fx-world feature.
 *  - Reasons: `setReason(kind, on)` with kind 'combat' (the weapon stance for COMBAT_STANCE_MS after a swing or a hit),
 *    'sit' (posture) and 'vendor' (wave 8 stalls); the driver resolves them with `pickIdle` (vendor > sit > combat >
 *    stand) and calls `EntityView.setIdle` (SIT_DOWN / STAND_UP transitions when asked for).
 *  - Variants: after each STAND1 cycle of a standing NPC, a VARIANT_CHANCE chance of one of its idle variants (STAND2-4,
 *    TURN_L/R), never two in a row, from a generator seeded by the entity id. Players fidget with STAND3 now and then
 *    (FIDGET_CHANCE per cycle). Mobs keep STAND1 (they wander).
 * `idleOf(view)` returns a view's driver, so any lane can add its reason.
 */
import type { EntityAttachment, EntityView } from './entities.ts'
import { pickIdle, type IdleKind } from './fx/types.ts'

/** The weapon stance lasts this long after the last swing or hit (ms) [likely; retail timeout unknown]. */
export const COMBAT_STANCE_MS = 5000
/** Chance per finished STAND1 cycle that a standing NPC plays one of its variants. */
export const VARIANT_CHANCE = 0.2
/** Chance per finished STAND1 cycle that a standing player fidgets (STAND3). */
export const FIDGET_CHANCE = 0.08
/** STAND1 cycle length when the clip's duration is unknown (ms). */
const DEFAULT_CYCLE_MS = 3000

/** mulberry32: a small seeded generator (every viewer of an entity rolls the same sequence). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0 || 0x2545f491
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The variant schedule of one standing model: `tick(dtMs, standing)` counts STAND1 cycles while standing idle and returns
 * the variant to play at the end of a cycle (or null). The cycle after a variant never plays another.
 */
export class VariantScheduler {
  private since = 0
  private lastWasVariant = false
  private readonly rng: () => number

  constructor(private readonly variants: readonly string[], private readonly cycleMs: number, private readonly chance: number, seed: number) {
    this.rng = seededRandom(seed)
  }

  tick(dtMs: number, standing: boolean): string | null {
    if (!standing || !this.variants.length) {
      this.since = 0
      return null
    }
    this.since += dtMs
    if (this.since < this.cycleMs) return null
    this.since -= this.cycleMs
    if (this.lastWasVariant) {
      this.lastWasVariant = false
      return null
    }
    if (this.rng() >= this.chance) return null
    this.lastWasVariant = true
    return this.variants[Math.min(this.variants.length - 1, Math.floor(this.rng() * this.variants.length))]!
  }

  /** A variant just played outside the schedule (keeps the "never two in a row" rule). */
  played(): void {
    this.lastWasVariant = true
    this.since = 0
  }
}

const drivers = new WeakMap<EntityView, IdleDriver>()

/** The idle driver of a view (null when the fx-world feature has not hung one on it). */
export function idleOf(view: EntityView): IdleDriver | null {
  return drivers.get(view) ?? null
}

export class IdleDriver implements EntityAttachment {
  private readonly reasons = new Set<IdleKind>()
  private combatUntil = 0
  private clock = 0
  private variants: VariantScheduler | null = null
  /** Sounds / particles hook: a variant clip started. */
  onVariant?: (clip: string) => void

  constructor(readonly view: EntityView) {
    drivers.set(view, this)
    if (view.state.posture === 'sit') this.reasons.add('sit')
  }

  loaded(): void {
    const v = this.view
    const a = v.actor
    // Arrived sitting (a late joiner sees posture 'sit'): straight into the SIT loop, no SIT_DOWN.
    this.apply()
    if (!a || v.kind === 'mob' || v.kind === 'item') return
    const cycle = a.clips.get(a.clipFor('STAND1')?.name ?? 'STAND1')?.durationMs ?? DEFAULT_CYCLE_MS
    const list = v.kind === 'npc' ? a.idleVariants() : a.idleVariants().filter(n => /^STAND3(_|$)/.test(n))
    if (list.length) this.variants = new VariantScheduler(list, Math.max(500, cycle), v.kind === 'npc' ? VARIANT_CHANCE : FIDGET_CHANCE, v.id * 2654435761)
  }

  /** Turns a reason on or off; `transition` 'play' shows SIT_DOWN / STAND_UP. */
  setReason(kind: Exclude<IdleKind, 'stand'>, on: boolean, transition?: 'play'): void {
    if (kind === 'combat') {
      this.combatUntil = on ? this.clock + COMBAT_STANCE_MS : 0
    }
    if (on === this.reasons.has(kind)) return
    // A seated character being killed dies from the seat: the server's 'stand' (and your own 'dead') arrive before the
    // killing blow is shown, so the seat stays until the death, which clears it (update).
    if (kind === 'sit' && !on && (this.view.dying || this.view.dead)) return
    if (on) this.reasons.add(kind)
    else this.reasons.delete(kind)
    this.apply(transition)
  }

  /** A swing or a hit: the combat stance for COMBAT_STANCE_MS more. */
  combat(): void {
    this.setReason('combat', true)
  }

  has(kind: IdleKind): boolean {
    return this.reasons.has(kind)
  }

  /** The idle the reasons ask for. */
  get kind(): IdleKind {
    return pickIdle(this.reasons)
  }

  private apply(transition?: 'play'): void {
    this.view.setIdle(this.kind, transition)
  }

  update(_now: number, dt: number): void {
    const ms = dt * 1000
    this.clock += ms
    if (this.reasons.has('combat') && this.clock >= this.combatUntil) {
      this.reasons.delete('combat')
      this.apply()
    }
    const v = this.view
    if (v.dead) {
      // A death ends the stance and the seat (a revived character stands).
      if (this.reasons.has('combat') || this.reasons.has('sit')) {
        this.reasons.delete('combat')
        this.reasons.delete('sit')
        this.apply()
      }
      return
    }
    if (!this.variants) return
    const standing = !v.moving && this.kind === 'stand' && !!v.actor
    const clip = this.variants.tick(ms, standing)
    if (clip && v.actor?.playOverlay(clip)) this.onVariant?.(clip)
  }

  dispose(): void {
    drivers.delete(this.view)
  }
}
