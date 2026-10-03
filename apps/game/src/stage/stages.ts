/**
 * The character-screen stages (docs/SCREENS.md §0B.2, lane SCR-R): data only. Both stages stand on ONE spot of the
 * Jangan south-gate steps ("the palace steps", §0B.1: glTF (101.0, −3.26, −56.0) in jangan-fields, region (168, 97)) and
 * share one loaded `World`; create only turns the camera round to the plaza and the golden dragon fountain.
 *
 * - Select looks south (+Z) at the steps and the south gatehouse; up to four characters stand in a shallow arc facing
 *   the camera (stage/slots.ts). Its distance is the fit rule (slots.ts `selectFitDistance`), not `distM`, which is the
 *   16:9 value the rule gives (3.94 m).
 * - Create looks north (−Z) at the plaza; one character on the spot, the camera trucked 0.45 m right (the character
 *   sits at ~43 % of the width, clear of the calligraphy panel), a face zoom key, and the objects' draw range capped at
 *   0.6 while it is up (§0B.9; re-benched after batching, open question 9).
 * - Time: the server's clock, held at sunset at night (stage/stage-time.ts); the fallback 0.773 is sunset at the
 *   default season (+12°). Weather: the server's, at half intensity, never lightning.
 *
 * Another Jangan spot is a change here only (open question 1). `stages.test.ts` checks these keys on the served export.
 */
import type { StageDef, StageId } from './types.ts'

/** The palace steps (SCREENS §0B.1): the spot the user picked, glTF metres in the jangan-fields frame. */
export const STAGE_SPOT = { x: 101.0, z: -56.0, yHint: -3.26 } as const

/** `sunriseSunset(12).set` (the default season): the time held at night, and the time without a server clock. */
export const STAGE_SUNSET_FALLBACK = 0.773

/** The stages' stream (SCREENS §0B.4): 150 m around the spot (7 regions), 12 fetches (nothing else competes). */
export const STAGE_STREAM = { loadRadiusM: 150, unloadRadiusM: 230, maxFetches: 12 } as const

/** The export a 'server' stage loads when the server names none (the deploy default, deploy/config.sh). */
export const STAGE_DEFAULT_WORLD = 'jangan-fields'

/** Select: the selected character steps this far toward the camera (0.5 m put the feet into the bottom bar, §0B.2). */
export const SELECT_STEP_M = 0.3
/**
 * SCR-R: the selected character stands at most this far in front of the row's line (the arc's 0.2 m at the outer slots
 * plus the step would be 0.5 m, feet at 84.4 % of the height at 16:9, into the bottom bar; 0.4 m keeps them at 83.2 %).
 */
export const SELECT_MAX_PULL_M = 0.4

/** Select: slot spacing across the view and the arc's pull toward the camera at the outer slots (§0B.2). */
export const SLOT_SPACING_M = 1.3
export const SLOT_ARC_M = 0.2

/** The idle drift of the select camera (SCREENS §0B.2 "idle life"; scope cut 4): ±0.10 m sideways on a 24 s sine. */
export const STAGE_DRIFT = { amplitudeM: 0.1, periodS: 24 } as const

/** Select ↔ create: the camera orbits 180° round the spot in this long (ease in-out; scope cut 1: a dip to black). */
export const STAGE_ORBIT_MS = 1000

/** Create's zoom button blends the camera between the full-body and face keys in this long (§0B.2). */
export const STAGE_ZOOM_MS = 500

/** The two stages of this wave (SCREENS §0B.2). */
export const STAGES: Readonly<Record<StageId, StageDef>> = {
  select: {
    id: 'select',
    world: 'server',
    spot: { ...STAGE_SPOT },
    // The row faces north, toward the camera; each slot turns to the camera position (slots.ts).
    facing: Math.PI,
    // Look heading 0: looking +Z (south) at the steps and the gatehouse. distM is the fit rule's 16:9 value.
    camera: { kind: 'fixed', distM: 3.94, heightM: 1.35, yaw: 0, fovDeg: 50, targetHeightM: 1.05 },
    time: { kind: 'server', fallback: STAGE_SUNSET_FALLBACK },
    weather: 'server',
    readyRadiusM: STAGE_STREAM.loadRadiusM,
  },
  create: {
    id: 'create',
    world: 'server',
    spot: { ...STAGE_SPOT },
    // The character faces south, toward the camera; the turntable turns it.
    facing: 0,
    // Look heading π: looking −Z (north) at the plaza, the golden dragon 25 m away, the red gate pillars.
    camera: {
      kind: 'fixed', distM: 3.6, heightM: 0.9, yaw: Math.PI, fovDeg: 50, targetHeightM: 0.75, truckM: 0.45,
      zoom: { distM: 1.6, heightM: 1.62, targetHeightM: 1.5, truckM: 0.2 },
    },
    time: { kind: 'server', fallback: STAGE_SUNSET_FALLBACK },
    weather: 'server',
    readyRadiusM: STAGE_STREAM.loadRadiusM,
    rangeScaleCap: 0.6,
  },
}

/** Export folder names the stage loads (the wire's rule for `ServerInfo.world`, protocol.ts). */
const WORLD_NAME = /^[a-z0-9-]{1,64}$/

/**
 * The export a stage loads: its own folder, or for 'server' the selected server's `ServerInfo.world` (a malformed or
 * missing name: the deploy default, jangan-fields).
 */
export function stageWorld(def: Pick<StageDef, 'world'>, serverWorld: string | null | undefined): string {
  if (def.world !== 'server') return def.world
  return typeof serverWorld === 'string' && WORLD_NAME.test(serverWorld) ? serverWorld : STAGE_DEFAULT_WORLD
}
