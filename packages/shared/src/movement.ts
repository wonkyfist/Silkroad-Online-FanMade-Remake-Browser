/**
 * The jump (Space) timing constants shared by the server and the client (docs/MOVEMENT.md §4.2, §5, §6;
 * docs/WAVE_PLAN6.md §3.1). Pure and environment-neutral.
 *
 * The jump is cosmetic and server-authoritative: the client sends `jump {}` (a GameplayRequest), the server answers
 * with one `actionResult` and tells every viewer (the jumper included) `jump {id, at}`. It never changes a position or
 * a move, so it can never cross a wall, a blocked nav edge or the coast bounds line.
 */

/**
 * Minimum time between two accepted jumps of one player (server `p.cooldowns` key `move.jump`). It outlasts the air of
 * every clip (P-JUMP 2026-10-01: take-off 133–200 ms, touch-down 833–900 ms; docs/MOVEMENT.md §3.2), so the next jump's
 * crouch starts during the landing absorb and never cuts a jump in the air.
 */
export const JUMP_COOLDOWN_MS = 1000

/** A viewer that receives `jump` later than this after `at` (server ms) plays nothing. */
export const JUMP_LATE_DROP_MS = 600

/**
 * The spec's echo window (MOVEMENT §5). The client now matches the echo to its request instead (a FIFO of the presses
 * in flight, apps/game world/features/movement.ts JumpEcho; MV-1): a timer on the local clock measured the round trip
 * while the late drop measures one way, so a 600–1200 ms round trip played the own jump twice.
 */
export const JUMP_ECHO_WINDOW_MS = 600

/** The furthest a late viewer seeks into the clip: the take-off. It may skip the crouch, never the air. */
export const JUMP_MAX_SEEK_MS = 200

/**
 * The server accepts a jump this long before its cooldown ends, so a player tapping at the client gate's own
 * 1000 ms rhythm is not refused by arrival jitter (docs/MOVEMENT.md §4.2, fact-check 2). The rate limit still caps abuse.
 */
export const JUMP_COOLDOWN_SLACK_MS = 150

/** The key of the jump cooldown in the server's per-player cooldown map (collides with no item or mount group). */
export const JUMP_COOLDOWN_KEY = 'move.jump'
