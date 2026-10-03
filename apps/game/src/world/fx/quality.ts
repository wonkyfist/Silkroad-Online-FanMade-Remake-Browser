/**
 * Effect budgets per graphics preset (docs/EFFECTS.md §7 "Performance on the N100", docs/WAVE_PLAN2.md §5.14): each
 * wave-7B effect family that costs frame time has a switch here, read from Options → Graphics → preset.
 *
 * - weapon trails: one ribbon per swinging actor (<= 48 samples), off on 'low';
 * - hit lights (M12): a pool of 2 point lights, off on 'low';
 * - world ambient particles (chimney smoke, waterfalls, portals): the nearest N within 60 m, 0 = off;
 * - drop sparkles: at most N drops sparkle at once (the rest lie there without one);
 * - the 7.2 s level-up column and the other SYSTEM_* one-shots always play (rare, and they are the feedback);
 * - G-11 (WAVE_PLAN7 §5.5 G1): the hit effects of fights the own character is not in, live at once at most (20 players
 *   at a world boss spawned ≈ 40 nine-emitter effects, ≈ 1/3 of the frame on Medium WebGPU); Low keeps today's (no
 *   cap: the Low guard). Hits by or on the own character always play. G1 rescue: Medium 12 → 6 (the boss fight at
 *   Bandit's Mountain, interleaved: 18.1 → 17.0 ms p95; work/tmp/w11-rescue/bench.md).
 * - G1 rescue (the same fight): weapon trails of other characters drawing at once, at most (`otherTrails`; the own
 *   character's always draw). Low has no trails at all.
 * - G1 rescue: the always-on glows of monster and NPC models (the Yeohas' green eyes, EFFECTS §3.2) play on the
 *   `ambientModels` nearest models (features/fx-world.ts; it was the first 20 to arrive on Medium, 40 on High: a Yeoha
 *   nest by Tiger Girl's camp kept 60 emitters alive). Low has none.
 *
 * I7B [our rule]: the numbers follow the lane caps on 'high' (40 ambient, 30 sparkles) and halve them on 'medium'.
 */
import { settings, type GraphicsPreset } from '../../settings.ts'

export interface FxBudget {
  trails: boolean
  hitLights: boolean
  /** Live ambient emitters at most (0: none). */
  ambientMax: number
  /** Drops with a live sparkle at most. */
  dropSparkles: number
  /** Live hit effects of fights the own character is not in, at most (Infinity: no cap). */
  otherHits: number
  /** Weapon trails of other characters drawing at once, at most (Infinity: no cap). */
  otherTrails: number
  /** Character models playing their always-on glows at once, at most (the nearest ones). */
  ambientModels: number
}

export const FX_BUDGETS: Readonly<Record<GraphicsPreset, Readonly<FxBudget>>> = {
  low: { trails: false, hitLights: false, ambientMax: 0, dropSparkles: 8, otherHits: Infinity, otherTrails: Infinity, ambientModels: 0 },
  medium: { trails: true, hitLights: true, ambientMax: 20, dropSparkles: 15, otherHits: 6, otherTrails: 4, ambientModels: 8 },
  high: { trails: true, hitLights: true, ambientMax: 40, dropSparkles: 30, otherHits: 24, otherTrails: 8, ambientModels: 20 },
  // Wave 9 (docs/WAVE_PLAN3.md D5): Ultra keeps High's effect budget.
  ultra: { trails: true, hitLights: true, ambientMax: 40, dropSparkles: 30, otherHits: 24, otherTrails: 8, ambientModels: 20 },
}

/** The budget of `preset` (default: the current settings). */
export function fxBudget(preset: GraphicsPreset = settings.get().graphics.preset): Readonly<FxBudget> {
  return FX_BUDGETS[preset] ?? FX_BUDGETS.high
}
