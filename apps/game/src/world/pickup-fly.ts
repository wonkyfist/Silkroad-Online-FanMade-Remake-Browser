/**
 * Pickup feedback (docs/UX_GAPS.md F9, lane UX-R): when an item we picked up leaves the ground, its icon flies from
 * where it lay to the inventory button (or the bottom-right corner when the menu bar is hidden). The server sends the
 * item's `despawn` and our `inventoryUpdate` in either order, so both are remembered for a moment and matched by item
 * code (gold by the gold total changing). Only items that vanish within reach of us count; someone else's pickup
 * never flies. `PickupMatcher` is the pure part (tested without a DOM).
 */
import { isGold } from './autoloot.ts'

/** How close (m) to us an item must vanish to count as our pickup (PICKUP_RANGE is 2 m; the walk may stop short). */
export const PICKUP_NEAR_M = 3
/** How long a despawn and an inventory update wait for each other (ms). */
export const PICKUP_MATCH_MS = 1500
export const FLY_MS = 650

export interface PickupFlight {
  code: string
  from: { x: number; y: number }
}

interface Removed extends PickupFlight {
  at: number
}

interface Arrival {
  codes: Set<string>
  gold: boolean
  at: number
}

/** Pairs "an item vanished next to us" with "our bag got that item" (either order, within PICKUP_MATCH_MS). */
export class PickupMatcher {
  private removed: Removed[] = []
  private arrivals: Arrival[] = []

  /** An item left the view next to us; `from` is its last screen point (CSS px). Returns a flight if it matched. */
  removedNear(code: string, from: { x: number; y: number }, now: number): PickupFlight | null {
    this.expire(now)
    const i = this.arrivals.findIndex(a => matches(a, code))
    if (i >= 0) {
      this.consume(i, code)
      return { code, from }
    }
    this.removed.push({ code, from, at: now })
    return null
  }

  /** Our inventory changed: the item codes that landed in the bag, and whether gold changed. */
  arrived(codes: Iterable<string>, gold: boolean, now: number): PickupFlight[] {
    this.expire(now)
    const a: Arrival = { codes: new Set(codes), gold, at: now }
    const out: PickupFlight[] = []
    this.removed = this.removed.filter(r => {
      if (!matches(a, r.code)) return true
      out.push({ code: r.code, from: r.from })
      if (!isGold(r.code)) a.codes.delete(r.code)
      else a.gold = false
      return false
    })
    if (a.codes.size || a.gold) this.arrivals.push(a)
    return out
  }

  private consume(i: number, code: string): void {
    const a = this.arrivals[i]!
    if (isGold(code)) a.gold = false
    else a.codes.delete(code)
    if (!a.codes.size && !a.gold) this.arrivals.splice(i, 1)
  }

  private expire(now: number): void {
    this.removed = this.removed.filter(r => now - r.at <= PICKUP_MATCH_MS)
    this.arrivals = this.arrivals.filter(a => now - a.at <= PICKUP_MATCH_MS)
  }
}

function matches(a: Arrival, code: string): boolean {
  return isGold(code) ? a.gold : a.codes.has(code)
}

/** Flies an icon (or a gold dot when there is none) from `from` to `to` (viewport CSS px), then removes it. */
export function flyIcon(host: HTMLElement, icon: string | null, from: { x: number; y: number }, to: { x: number; y: number }): void {
  if (typeof document === 'undefined') return
  const e = document.createElement('div')
  e.className = `ux-pickup-fly${icon ? '' : ' no-icon'}`
  if (icon) e.style.backgroundImage = `url("${icon}")`
  e.style.left = `${from.x}px`
  e.style.top = `${from.y}px`
  host.append(e)
  // Two frames so the start position is laid out before the transition starts.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      e.style.transform = `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(0.55)`
      e.style.opacity = '0.2'
    }),
  )
  setTimeout(() => e.remove(), FLY_MS + 100)
}
