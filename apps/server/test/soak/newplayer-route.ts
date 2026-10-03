import type { NavPoint, NavProvider } from '../../src/nav.ts'

/**
 * A tiny waypoint router for the new-player bot (newplayer.ts): the server's walker moves in one straight chord and
 * stops at the first wall (docs/NAVIGATION.md §6), so a human clicks waypoints around obstacles. This finds them the
 * same way: A* over a grid of `step`-metre points whose edges are straight walks the navmesh does not clip, then
 * string-pulls the grid path into as few straight legs as the walker accepts.
 */

export interface RouteOptions {
  /** Grid spacing (metres). */
  step?: number
  /** Give up after this many node expansions. */
  maxExpand?: number
  /** Count the goal reached within this distance (metres). */
  arrive?: number
  /** Extra cost (metres) of standing at x/z, e.g. near a monster that attacks on sight; 0 = none. */
  penalty?: (x: number, z: number) => number
}

interface Node {
  key: number
  p: NavPoint
  g: number
  f: number
  parent: Node | null
}

class Heap {
  private a: Node[] = []
  get size(): number {
    return this.a.length
  }
  push(n: Node): void {
    const a = this.a
    a.push(n)
    let i = a.length - 1
    while (i > 0) {
      const j = (i - 1) >> 1
      if (a[j].f <= a[i].f) break
      ;[a[i], a[j]] = [a[j], a[i]]
      i = j
    }
  }
  pop(): Node | undefined {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length > 0 && last) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l].f < a[m].f) m = l
        if (r < a.length && a[r].f < a[m].f) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}

/** Penalty summed every few metres along a straight chord. */
function chordPenalty(penalty: (x: number, z: number) => number, a: NavPoint, b: NavPoint): number {
  const d = Math.hypot(b.x - a.x, b.z - a.z)
  const n = Math.max(1, Math.ceil(d / 3))
  let sum = 0
  for (let k = 1; k <= n; k++) sum += penalty(a.x + ((b.x - a.x) * k) / n, a.z + ((b.z - a.z) * k) / n)
  return sum
}

/** Penalty of the grid path's points i+1..j (the path the chord would replace), with a little slack. */
function chainPenalty(penalty: (x: number, z: number) => number, pts: NavPoint[], i: number, j: number): number {
  let sum = 0
  for (let k = i + 1; k <= j; k++) sum += penalty(pts[k].x, pts[k].z)
  return sum + 1
}

/** Whether the walker goes straight from `a` to x/z without being clipped. */
export function clearWalk(nav: NavProvider, a: NavPoint, x: number, z: number): NavPoint | null {
  const w = nav.walk(a, x, z)
  if (!w || w.blocked) return null
  return Math.hypot(w.end.x - x, w.end.z - z) < 0.25 ? w.end : null
}

/**
 * Waypoints (x/z, the last one within `arrive` of the goal) from `from` to `to`, or null when there is no way.
 * The first waypoint is the first straight leg's end (never `from` itself).
 */
export function route(nav: NavProvider, from: NavPoint, to: { x: number; z: number }, opts: RouteOptions = {}): [number, number][] | null {
  const step = opts.step ?? 3
  const maxExpand = opts.maxExpand ?? 250_000
  const arrive = opts.arrive ?? 1.5
  const penalty = opts.penalty
  if (!penalty && clearWalk(nav, from, to.x, to.z)) return [[to.x, to.z]]
  const K = 1 << 15
  const keyOf = (ix: number, iz: number) => (ix + K / 2) * K + (iz + K / 2)
  const h = (x: number, z: number) => Math.hypot(x - to.x, z - to.z)
  const open = new Heap()
  const best = new Map<number, number>()
  const start: Node = { key: -1, p: from, g: 0, f: h(from.x, from.z), parent: null }
  open.push(start)
  let expanded = 0
  let goal: Node | null = null
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  while (open.size > 0 && expanded < maxExpand) {
    const n = open.pop()!
    if (n.key >= 0 && (best.get(n.key) ?? Infinity) < n.g) continue
    expanded++
    if (h(n.p.x, n.p.z) <= step * 2.5) {
      const end = clearWalk(nav, n.p, to.x, to.z)
      if (end) {
        goal = { key: -2, p: end, g: n.g + h(n.p.x, n.p.z), f: 0, parent: n }
        break
      }
      if (h(n.p.x, n.p.z) <= arrive) {
        goal = n
        break
      }
    }
    const bx = Math.round(n.p.x / step)
    const bz = Math.round(n.p.z / step)
    const cand: [number, number][] = n.key === -1 ? [[bx, bz], ...dirs.map(([dx, dz]) => [bx + dx, bz + dz] as [number, number])] : dirs.map(([dx, dz]) => [bx + dx, bz + dz])
    for (const [ix, iz] of cand) {
      const x = ix * step
      const z = iz * step
      const key = keyOf(ix, iz)
      const d = Math.hypot(x - n.p.x, z - n.p.z)
      if (d < 0.01) continue
      const g = n.g + d + (penalty ? penalty(x, z) * (d / step) : 0)
      if ((best.get(key) ?? Infinity) <= g) continue
      const end = clearWalk(nav, n.p, x, z)
      if (!end) continue
      best.set(key, g)
      open.push({ key, p: end, g, f: g + h(x, z) * 1.2, parent: n })
    }
  }
  if (!goal) return null
  const pts: NavPoint[] = []
  for (let n: Node | null = goal; n; n = n.parent) pts.push(n.p)
  pts.reverse()
  // String-pull: from each point, the farthest later point the walker reaches in one straight leg.
  const out: [number, number][] = []
  let i = 0
  while (i < pts.length - 1) {
    let j = Math.min(pts.length - 1, i + 60)
    for (; j > i + 1; j--) if (clearWalk(nav, pts[i], pts[j].x, pts[j].z) && (!penalty || chordPenalty(penalty, pts[i], pts[j]) <= chainPenalty(penalty, pts, i, j))) break
    out.push([pts[j].x, pts[j].z])
    i = j
  }
  return out
}
