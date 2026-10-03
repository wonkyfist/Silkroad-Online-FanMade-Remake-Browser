/**
 * Where every entity stands (docs/NAVIGATION.md §5): the local player keeps a retained nav surface (NavTrack) and
 * walks each server MoveState with moveStraight, taking its height from the surface of the leg it is on; everyone
 * else is located from the server's position (the surface nearest the server's y: plaza over the sunken terrain,
 * bridge deck over the river bed). Without a navmesh (flat fallback ground) heights come from the ground alone.
 *
 * Region streaming (docs/FIELDS.md §3.8): the client navmesh only has the loaded regions. A move whose chord touches
 * a region that is not ready is taken from the server unchanged and the track is "unsettled": the own heights then
 * come from the ground (the server's y where nothing is loaded) until the next stop, warp or covered move places the
 * track again.
 */
import type { MoveState, Vec3 } from '@sro/shared'
import { NavTrack, type World } from '@sro/world-render'
import type { WorldGround } from '../ground.ts'

export class EntityHeights {
  selfId = -1
  private track: NavTrack | null = null
  /** Streaming: the track is not trusted (the last move or placement touched regions that were not loaded). */
  private unsettled = false

  constructor(private readonly ground: WorldGround, private readonly world: World | null) {}

  /** The local player's retained surface ('terrain' or the object cell), for the HUD/debug. */
  get selfSurface(): string {
    const s = this.track?.pos.surface
    if (!s) return '-'
    return s.kind === 'terrain' ? 'terrain' : `object ${s.instance}:${s.cell}`
  }

  /** Spawn, warp, respawn, (re)enter: no retained surface, so the one nearest the server's y (§5.2). */
  placeSelf(pos: Vec3): void {
    if (!this.world) return
    this.unsettled = !this.covers(pos[0], pos[2], pos[0], pos[2])
    if (this.unsettled) return
    if (this.track) this.track.place(pos[0], pos[2], pos[1])
    else this.track = new NavTrack(this.world.nav, pos[0], pos[2], pos[1])
  }

  /**
   * A server move of the local player: walked on the retained surface from `from` toward `to`; the returned move
   * ends where that walk stops (the server's own navmesh clip gives the same point; a flat server lets it through).
   */
  selfMove(move: MoveState): MoveState {
    const track = this.track
    if (!track) return move
    if (!this.covers(move.from[0], move.from[2], move.to[0], move.to[2])) {
      this.unsettled = true
      return move
    }
    if (this.unsettled) {
      // Covered again: no retained surface to trust, start from the surface nearest the server's y.
      track.place(move.from[0], move.from[2], move.from[1])
      this.unsettled = false
    }
    const r = track.begin(move.from[0], move.from[2], move.to[0], move.to[2], move.from[1])
    if (!r.blocked) return move
    const end: Vec3 = [r.end.x, r.end.y, r.end.z]
    return { ...move, to: end }
  }

  /** The local player stopped at `pos` (server stop): keep the surface (unless the server's y says it is stale), settle there. */
  selfStop(pos: Vec3): void {
    if (this.unsettled || !this.track) this.placeSelf(pos)
    else this.track.settle(pos[0], pos[2], pos[1])
  }

  /** Height (m) of entity `id` at (x, z); `serverY` is the y the server gave for that position. */
  heightOf(id: number, x: number, z: number, serverY: number): number {
    if (id === this.selfId && this.track && !this.unsettled) return this.track.heightAt(x, z)
    return this.ground.heightAt(x, z, serverY)
  }

  /** True when the client nav has every region under the segment's bounding box (always without streaming). */
  private covers(x0: number, z0: number, x1: number, z1: number): boolean {
    const stream = this.world?.stream
    return !stream || stream.navCovers(x0, z0, x1, z1)
  }
}
