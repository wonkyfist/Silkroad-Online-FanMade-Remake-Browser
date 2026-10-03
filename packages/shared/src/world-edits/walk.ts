/**
 * The Walkable brush's hard limits (docs/WORLD_EDITOR.md §4.7, D29): the tiles that may never be forced open. One pure
 * rule for the editor (its brush refuses those tiles, with a plain-English message) and the converter's nav step (it
 * ignores such a force-open with a warning: a building moved onto it after the stroke, a hand-edited layer). Force
 * closed is never refused: Publish's checks (traps, reachability, roads) catch a cut road.
 *
 * A tile (2 m, tz * 96 + tx) is refused when
 * 1. its region lies outside the playable rectangle (`stream.playable`: nobody walks there, the server's clamp keeps
 *    players in);
 * 2. its centre is in the coast's sea mask (coast/field.png R >= 128 at the nearest texel: what `World.coast.seaAt`
 *    reads on the client; `seaTestOfField` here for the converter);
 * 3. it overlaps the XZ box of a collision navmesh (a building, a wall, a rock, a trunk: the object's own floor and
 *    walls decide walking there). Boxes are world file space (dm); a box touching the tile counts.
 */
import { WE_REGION_M, WE_TILE_M, WE_TILES, WE_WALK } from './types.ts'

/** Per-tile refusal codes (`walkRefusals`). */
export const WALK_REFUSAL = { none: 0, bounds: 1, sea: 2, object: 3 } as const
export type WalkRefusalKind = 'bounds' | 'sea' | 'object'
export type WalkRefusalCounts = Record<WalkRefusalKind, number>

/** A collision footprint's XZ box, world file space (dm). */
export interface WalkFootprintBox {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

export interface WalkGuard {
  /** `stream.playable` (region units, inclusive); absent: no bounds limit. */
  playable?: { x0: number; x1: number; z0: number; z1: number } | null
  /** The sea mask at glTF (x, z); absent: no sea. */
  seaAt?: ((x: number, z: number) => boolean) | null
  /** manifest.space.originRegion (the glTF frame of `seaAt`); required with `seaAt`. */
  origin?: { x: number; z: number } | null
}

/** Region edge and tile edge in world file units (dm). */
const REGION_DM = WE_REGION_M * 10
const TILE_DM = WE_TILE_M * 10

/** The glTF centre (x, z) of tile (tx, tz) of region (rx, rz). */
export function walkTileCentre(rx: number, rz: number, tx: number, tz: number, origin: { x: number; z: number }): [number, number] {
  return [WE_REGION_M * (rx - origin.x) + WE_TILE_M * tx + WE_TILE_M / 2, -(WE_REGION_M * (rz - origin.z) + WE_TILE_M * tz + WE_TILE_M / 2)]
}

/** 96 x 96 WALK_REFUSAL codes for region (rx, rz): bounds first, then footprints, then the sea. */
export function walkRefusals(rx: number, rz: number, guard: WalkGuard, footprints: Iterable<WalkFootprintBox>): Uint8Array {
  const out = new Uint8Array(WE_TILES * WE_TILES)
  const p = guard.playable
  if (p && (rx < p.x0 || rx > p.x1 || rz < p.z0 || rz > p.z1)) return out.fill(WALK_REFUSAL.bounds)
  const X0 = REGION_DM * rx
  const Z0 = REGION_DM * rz
  for (const b of footprints) {
    if (b.maxX < X0 || b.minX >= X0 + REGION_DM || b.maxZ < Z0 || b.minZ >= Z0 + REGION_DM) continue
    const tx0 = Math.max(0, Math.floor((b.minX - X0) / TILE_DM)), tx1 = Math.min(WE_TILES - 1, Math.floor((b.maxX - X0) / TILE_DM))
    const tz0 = Math.max(0, Math.floor((b.minZ - Z0) / TILE_DM)), tz1 = Math.min(WE_TILES - 1, Math.floor((b.maxZ - Z0) / TILE_DM))
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) out[tz * WE_TILES + tx] = WALK_REFUSAL.object
  }
  const sea = guard.seaAt
  const origin = guard.origin
  if (sea && origin) {
    for (let tz = 0; tz < WE_TILES; tz++) {
      for (let tx = 0; tx < WE_TILES; tx++) {
        const t = tz * WE_TILES + tx
        if (out[t]) continue
        const [x, z] = walkTileCentre(rx, rz, tx, tz, origin)
        if (sea(x, z)) out[t] = WALK_REFUSAL.sea
      }
    }
  }
  return out
}

export const noWalkRefusals = (): WalkRefusalCounts => ({ bounds: 0, sea: 0, object: 0 })

const KIND_OF: Record<number, WalkRefusalKind> = { [WALK_REFUSAL.bounds]: 'bounds', [WALK_REFUSAL.sea]: 'sea', [WALK_REFUSAL.object]: 'object' }
export const walkRefusalKind = (code: number): WalkRefusalKind | null => KIND_OF[code] ?? null

/**
 * The walk codes with every refused force-open set back to auto (the converter's rule); the input is not mutated.
 * `codes` is the input itself when nothing is refused.
 */
export function guardWalkCodes(codes: Uint8Array, refusals: ArrayLike<number>): { codes: Uint8Array; refused: WalkRefusalCounts } {
  const refused = noWalkRefusals()
  let out = codes
  for (let t = 0; t < codes.length; t++) {
    if (codes[t] !== WE_WALK.open || !refusals[t]) continue
    if (out === codes) out = Uint8Array.from(codes)
    out[t] = WE_WALK.auto
    refused[walkRefusalKind(refusals[t]!)!]++
  }
  return { codes: out, refused }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "5 tiles can't be opened: 3 outside the playable area, 2 under a building or object." ('' when none). */
export function walkRefusalSentence(c: WalkRefusalCounts): string {
  const n = c.bounds + c.sea + c.object
  if (!n) return ''
  const parts = [
    c.bounds ? `${c.bounds} outside the playable area (nobody walks there)` : '',
    c.sea ? `${c.sea} in the sea` : '',
    c.object ? `${c.object} under a building or object (its own floor decides walking there)` : '',
  ].filter(Boolean)
  return `${plural(n, 'tile')} can't be opened: ${parts.join(', ')}.`
}

/**
 * The client's sea test on the coast field's pixels (`manifest.coast.field`, coast/field.png RGBA8; world-render
 * ocean/field.ts `seaAt`): R >= 128 at the nearest texel, clamped to the field.
 */
export function seaTestOfField(
  field: { x0: number; z0: number; metresPerTexel: number; width: number; height: number }, rgba: ArrayLike<number>,
): (x: number, z: number) => boolean {
  if (rgba.length !== field.width * field.height * 4) throw new Error(`coast field: expected ${field.width} x ${field.height} RGBA, got ${rgba.length} values`)
  return (x, z) => {
    const i = Math.min(field.width - 1, Math.max(0, Math.floor((x - field.x0) / field.metresPerTexel)))
    const j = Math.min(field.height - 1, Math.max(0, Math.floor((z - field.z0) / field.metresPerTexel)))
    return rgba[(j * field.width + i) * 4]! >= 128
  }
}
