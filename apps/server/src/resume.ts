import type { Player } from './world.ts'

/**
 * Graceful reconnect (docs/NETWORK_AUDIT.md N5): when a socket drops without a goodbye (network blip, Wi-Fi switch,
 * a tab refresh, a heartbeat timeout), the character stays in the world for `resumeGraceS` seconds (config, default
 * 15) instead of vanishing: others keep seeing it, and its own client, which reconnects and re-sends `enterWorld`,
 * takes it back. The held body is mute (its messages are dropped) and does nothing (its action is cleared).
 *
 * Taking it back saves and removes the held body, then enters the character as usual from that save, so position, HP
 * and MP carry over exactly and every module sees the ordinary leave/enter pair. A logout (close 1000), leaveWorld,
 * a GM kick, a ban or the server shutting down never holds a body.
 */
export class BodyHolds {
  private readonly held = new Map<number, { p: Player; timer: NodeJS.Timeout; finish: () => void }>()

  constructor(
    private readonly graceMs: () => number,
    private readonly log: (m: string) => void,
  ) {}

  /** Holds `p` (true), or not (false: no grace configured, dead, or held already); `finish` saves and removes it. */
  hold(p: Player, finish: () => void): boolean {
    const ms = this.graceMs()
    if (ms <= 0 || p.dead || this.held.has(p.characterId)) return false
    p.send = () => {}
    p.action = null
    const timer = setTimeout(() => this.release(p.characterId), ms)
    timer.unref?.()
    this.held.set(p.characterId, { p, timer, finish })
    this.log(`${p.name} dropped: held ${Math.round(ms / 1000)} s for a reconnect`)
    return true
  }

  /** Ends the hold of a character now (its finish runs: saved and removed). false = none held. */
  release(characterId: number): boolean {
    const h = this.held.get(characterId)
    if (!h) return false
    clearTimeout(h.timer)
    this.held.delete(characterId)
    h.finish()
    return true
  }

  isHeld(characterId: number): boolean {
    return this.held.has(characterId)
  }

  get size(): number {
    return this.held.size
  }

  /** Saves and removes every held body `pick` chooses (maintenance mode: the non-staff ones). Returns how many. */
  releaseWhere(pick: (p: Player) => boolean): number {
    let n = 0
    for (const [id, h] of [...this.held]) if (pick(h.p) && this.release(id)) n++
    return n
  }

  /** Server shutdown: every held body is saved and removed. */
  releaseAll(): void {
    for (const id of [...this.held.keys()]) this.release(id)
  }
}

/**
 * Whether a connection that ended for `reason` (Connection.closeReason) leaves its character held for a reconnect:
 * a drop the player did not choose. A clean client close (1000 or 1005: logout, leaving the page through the menu), a kick,
 * a ban, a refused token and the shutdown do not.
 */
export function dropHoldsBody(reason: string): boolean {
  if (reason === 'heartbeat timeout' || reason.startsWith('socket error')) return true
  // replaced (4000): the same account logged in again, its new connection takes the body back; slow (4011): a client
  // that stopped reading, which reconnects
  if (reason.startsWith('server ')) return reason.startsWith('server 4000 ') || reason.startsWith('server 4011 ')
  const m = /^client (\d+)/.exec(reason)
  // 1000 / 1005: the client sent a close frame on purpose (the game sends 1000 on logout; a bare close() is 1005)
  return m !== null && m[1] !== '1000' && m[1] !== '1005'
}
