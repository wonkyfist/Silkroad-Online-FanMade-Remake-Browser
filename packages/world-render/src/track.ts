/**
 * A walker's retained nav surface on the client (NAVIGATION.md §5.1, §6.1): the local player keeps a NavPosition,
 * predicts each move with moveStraight (one straight chord, clipped at the first blocking edge) and reads its height
 * from the surface of the leg it is on, so it walks across the plaza, up stairs and over bridges instead of snapping
 * to whatever surface is nearest. No Babylon imports.
 */
import type { NavGltf, NavLeg, NavMoveResult, NavPosition } from '@sro/nav'
import { spawnAt } from './nav.ts'

/**
 * A retained surface whose height is further than this (m) from the server's y for the same point is stale (a missed
 * message, a server correction onto another deck): the walker re-locates on the surface nearest the server's y.
 */
export const RESYNC_Y_M = 0.5

export class NavTrack {
  /** Last known position (glTF metres) with its surface. */
  pos: NavPosition
  /** The move being walked (null when standing). */
  move: NavMoveResult | null = null
  private legs: NavLeg[] = []
  private legStart: number[] = []
  private total = 0
  private ox = 0
  private oz = 0
  private dx = 0
  private dz = 0

  constructor(readonly nav: NavGltf, x: number, z: number, yHint = Infinity) {
    this.pos = spawnAt(nav, x, z, yHint)
  }

  /** No retained surface (spawn, warp, respawn): the surface nearest to yHint at (x, z) (§5.2). */
  place(x: number, z: number, yHint = Infinity): NavPosition {
    this.move = null
    this.legs = []
    this.pos = spawnAt(this.nav, x, z, yHint)
    return this.pos
  }

  /**
   * Stands at (x, z) keeping the retained surface (a stop, or a server correction of a few centimetres). With the
   * server's `y`, a retained surface that disagrees by more than RESYNC_Y_M is replaced by the one nearest `y`.
   */
  settle(x: number, z: number, y?: number): NavPosition {
    this.move = null
    this.legs = []
    this.pos = this.at(x, z, y)
    return this.pos
  }

  /** (x, z) on the retained surface, or on the surface nearest the server's `y` when the retained one disagrees. */
  private at(x: number, z: number, y?: number): NavPosition {
    const kept = this.nav.settle(this.pos.surface, x, z)
    if (kept && (y === undefined || !Number.isFinite(y) || Math.abs(kept.y - y) <= RESYNC_Y_M)) return kept
    return spawnAt(this.nav, x, z, y !== undefined && Number.isFinite(y) ? y : this.pos.y)
  }

  /**
   * A move from (fromX, fromZ) toward (toX, toZ): settles at the start on the retained surface (a click while
   * running starts from the live point) and walks the chord. `result.end` is where the walk stops (short of the
   * destination when blocked), with its surface. `fromY` (the server's y at the start) resyncs a stale surface.
   */
  begin(fromX: number, fromZ: number, toX: number, toZ: number, fromY?: number): NavMoveResult {
    const from = this.at(fromX, fromZ, fromY)
    const r = this.nav.moveStraight(from, toX, toZ)
    this.pos = from
    this.move = r
    this.legs = r.legs
    this.legStart = []
    let s = 0
    for (const l of r.legs) {
      this.legStart.push(s)
      s += Math.hypot(l.x1 - l.x0, l.z1 - l.z0)
    }
    this.total = s
    this.ox = from.x
    this.oz = from.z
    const cx = toX - from.x
    const cz = toZ - from.z
    const cl = Math.hypot(cx, cz)
    this.dx = cl > 1e-9 ? cx / cl : 0
    this.dz = cl > 1e-9 ? cz / cl : 0
    if (s <= 1e-9) this.finish()
    return r
  }

  /**
   * Height (m) at (x, z) for the walker: on the surface of the leg containing the point while moving (the point's
   * distance along the chord picks the leg), else on the retained surface. Updates `pos`.
   */
  heightAt(x: number, z: number): number {
    if (this.move) {
      const s = (x - this.ox) * this.dx + (z - this.oz) * this.dz
      if (s >= this.total - 1e-6) {
        this.finish()
      } else {
        let i = this.legs.length - 1
        while (i > 0 && this.legStart[i]! > s) i--
        const leg = this.legs[i]!
        const y = this.nav.heightOn(leg.surface, x, z)
        if (Number.isFinite(y)) {
          this.pos = { x, y, z, surface: leg.surface }
          return y
        }
      }
    }
    if (x !== this.pos.x || z !== this.pos.z) {
      const p = this.nav.settle(this.pos.surface, x, z)
      // settle() clamps into the owned cell; keep the requested x/z (the entity is drawn where the server says).
      if (p) this.pos = { x, y: p.y, z, surface: p.surface }
      else this.pos = spawnAt(this.nav, x, z, this.pos.y)
    }
    return this.pos.y
  }

  private finish(): void {
    if (this.move) this.pos = { ...this.move.end }
    this.move = null
    this.legs = []
  }
}
