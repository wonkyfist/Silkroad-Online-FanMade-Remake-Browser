/**
 * The crowded-plaza switch with hysteresis (H-12 CR-1; WAVE_PLAN8 D24, WAVE_PLAN7 cut 20). One player count drives
 * two rules on Medium: the trees' LOD0 overlay draws within 20 m only, and the townsfolk go. A count that sits on the
 * line (a 15th player on the 60 m edge, the own character walking back and forth across it) must not flip them every
 * count: the switch turns on at `onAt` players and off only at `onAt - CROWD_OFF_GAP` or fewer, so LAB-12's numbers
 * (measured from 15 players on) stay valid.
 */

/** The switch turns off this many players below its on line (on at 15, off at 12). */
export const CROWD_OFF_GAP = 3

export class CrowdLatch {
  on = false

  constructor(readonly onAt: number) {}

  /** Feeds a count; returns the switch. */
  update(players: number): boolean {
    if (!this.on && players >= this.onAt) this.on = true
    else if (this.on && players <= this.onAt - CROWD_OFF_GAP) this.on = false
    return this.on
  }
}
