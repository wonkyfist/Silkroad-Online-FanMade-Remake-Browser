/**
 * Crowd rules for many characters on screen (docs/CHARACTERS.md §3, P0): the LAB switches. Every rule here keeps the
 * characters near the camera exactly as they were; each switch is on by default and the bench (debug/charbench.ts)
 * turns them off for the before/after runs on one page.
 *
 * - `outfit`: in a crowd, an other character beyond OUTFIT_FROM_M draws its body, hair and armour as one mesh with one
 *   atlas material (three/outfit-merge.ts; world/crowd-budget.ts decides who).
 * - `snap`: the same far characters change clips without the clip-change blend (three/models.ts `snapClips`), so a
 *   blend no longer holds them at the every-frame pose rate.
 */
export interface CharLodSwitches {
  outfit: boolean
  snap: boolean
  /**
   * P1a (docs/CHARACTERS.md §3.5): the crowd tier. In a crowd, every other character outside the close set (the
   * CLOSE_COUNT nearest within CLOSE_RANGE_M, and never the own character, the target, the hovered one or the party)
   * is drawn by a thin instance of its outfit batch skinned from a baked animation texture (three/crowd-tier.ts):
   * body, armour, hair, weapon and shield in one draw shared by everyone in the same outfit, no skeleton of its own.
   */
  crowdTier: boolean
  /** LAB only (the look check): the outfit merge at any distance, near characters too. Off in the game. */
  outfitNear: boolean
}

export const CHAR_LOD: CharLodSwitches = {
  outfit: true,
  snap: true,
  crowdTier: true,
  outfitNear: false,
}

/** P1a: the close set (drawn exactly as before the crowd rules): at most this many nearest other characters… */
export const CLOSE_COUNT = 8
/** …within this camera distance (m). */
export const CLOSE_RANGE_M = 12
/** A close character stays close out to this distance (m) and while it ranks within CLOSE_KEEP_RANK (no flicker). */
export const CLOSE_LEAVE_M = 15
export const CLOSE_KEEP_RANK = 10
/** A crowd character's clips step this often (Hz): only for their end events and the bone readers (effects, labels). */
export const CROWD_STEP_HZ = 5
/** New crowd members per crowd plan at most (each may bake a clip and build its outfit batch). */
export const CROWD_PER_PLAN = 8

/** One other character for closeSet: camera distance (m), never budgeted (`keep`), close at the last plan. */
export interface CloseEntry {
  d: number
  keep: boolean
  wasClose?: boolean
}

/**
 * Which characters are close (pure; `out[i]` for `entries[i]`): the kept ones always; of the others, the CLOSE_COUNT
 * nearest within CLOSE_RANGE_M, and one close at the last plan stays close while it is within CLOSE_LEAVE_M and ranks
 * within CLOSE_KEEP_RANK (a few more than CLOSE_COUNT can be close for a moment, never fewer than the rule).
 */
export function closeSet(entries: readonly CloseEntry[], out: boolean[] = []): boolean[] {
  out.length = entries.length
  const order: number[] = []
  for (let i = 0; i < entries.length; i++) {
    out[i] = entries[i]!.keep
    if (!entries[i]!.keep) order.push(i)
  }
  order.sort((a, b) => entries[a]!.d - entries[b]!.d || a - b)
  for (let k = 0; k < order.length; k++) {
    const e = entries[order[k]!]!
    if ((k < CLOSE_COUNT && e.d <= CLOSE_RANGE_M) || (e.wasClose && k < CLOSE_KEEP_RANK && e.d <= CLOSE_LEAVE_M)) out[order[k]!] = true
  }
  return out
}

/** The outfit merge starts this far from the camera (m): CLOSE_M, inside which nothing changes. */
export const OUTFIT_FROM_M = 15
/** A merged character stays merged until it is this much nearer than OUTFIT_FROM_M (m; no flicker at the line). */
export const OUTFIT_HYSTERESIS_M = 3
/** New outfit merges per crowd plan at most (each one copies a few textures and a few thousand vertices). */
export const OUTFITS_PER_PLAN = 3

/** Whether an other character at camera distance `d` (m) draws as one outfit mesh; `was`: it did at the last plan. */
export function wantsOutfit(d: number, was: boolean): boolean {
  return d > OUTFIT_FROM_M - (was ? OUTFIT_HYSTERESIS_M : 0)
}

/**
 * Licensed bodies (docs/CHARACTERS.md §16.8): their simplified LODs by camera distance. LOD0 (the bought geometry,
 * ≈ 20 parts and 100 k triangles) for the kept characters and anything within LICENSED_LOD1_FROM_M; LOD1 (one mesh
 * per material) beyond, the rest of the close set included; LOD2 beyond LICENSED_LOD2_FROM_M and for everyone the
 * crowd tier draws (its batch is built from the LOD2 parts). LICENSED_LOD_HYSTERESIS_M keeps a character at the line
 * from flickering.
 */
export const LICENSED_LOD1_FROM_M = 8
export const LICENSED_LOD2_FROM_M = 30
export const LICENSED_LOD_HYSTERESIS_M = 2

/** The licensed LOD of a character (pure): camera distance `d`, kept / close / in the crowd tier, its LOD at the last plan. */
export function licensedLodFor(d: number, o: { keep?: boolean; close?: boolean; crowd?: boolean }, was = 0): number {
  if (o.keep) return 0
  if (o.crowd) return 2
  const h = (lvl: number) => (was >= lvl ? -LICENSED_LOD_HYSTERESIS_M : 0)
  if (d > LICENSED_LOD2_FROM_M + h(2)) return o.close ? 1 : 2
  if (d > LICENSED_LOD1_FROM_M + h(1)) return 1
  return 0
}
