/** A click this close (CSS px) to a character's on-screen body selects it when the ray misses its pick proxy. */
export const PICK_SLACK_PX = 16

/** Distance (px) from point p to the segment a-b on screen. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** The candidate whose screen segment (feet to head) passes nearest (x, y), within `slack` px; null if none. */
export function nearestOnScreen<T>(x: number, y: number, candidates: Iterable<{ item: T; ax: number; ay: number; bx: number; by: number }>, slack = PICK_SLACK_PX): T | null {
  let best: T | null = null
  let bestD = slack
  for (const c of candidates) {
    const d = segmentDistance(x, y, c.ax, c.ay, c.bx, c.by)
    if (d < bestD) {
      bestD = d
      best = c.item
    }
  }
  return best
}
