import type { MeshNav, NavPoint } from '../../src/nav.ts'

/**
 * Click-to-move routes: A* over a 4 m grid whose edges are real walker chords (MeshNav.walk, not blocked), then
 * shortened to the fewest straight legs. Each leg is one moveTo, exactly what the server will accept.
 */
export class Planner {
  readonly cell = 4
  private readonly cache = new Map<string, { x: number; z: number }[]>()
  stats = { plans: 0, cached: 0, failed: 0, ms: 0 }

  constructor(private readonly nav: MeshNav) {}

  private clear(a: NavPoint, x: number, z: number): NavPoint | null {
    const w = this.nav.walk(a, x, z)
    return w && !w.blocked && Math.hypot(w.end.x - x, w.end.z - z) < 0.05 ? w.end : null
  }

  route(from: NavPoint, gx: number, gz: number): { x: number; z: number }[] | null {
    this.stats.plans++
    if (this.clear(from, gx, gz)) return [{ x: gx, z: gz }]
    const c = this.cell
    const key = `${Math.round(from.x / c)},${Math.round(from.z / c)}>${Math.round(gx / c)},${Math.round(gz / c)}`
    const hit = this.cache.get(key)
    if (hit && this.clear(from, hit[0]!.x, hit[0]!.z)) {
      this.stats.cached++
      return [...hit.slice(0, -1), { x: gx, z: gz }]
    }
    const started = performance.now()
    const path = this.search(from, gx, gz)
    this.stats.ms += performance.now() - started
    if (!path) {
      this.stats.failed++
      return null
    }
    // shortcut: from each point, the farthest later point reachable in one straight chord
    const out: { x: number; z: number }[] = []
    let i = 0
    let at: NavPoint = path[0]!
    while (i < path.length - 1) {
      let j = Math.min(path.length - 1, i + 48)
      let end: NavPoint | null = null
      for (; j > i + 1; j--) if ((end = this.clear(at, path[j]!.x, path[j]!.z))) break
      if (j === i + 1) end = path[j]!
      out.push({ x: path[j]!.x, z: path[j]!.z })
      at = end!
      i = j
    }
    this.cache.set(key, out)
    return out
  }

  private search(from: NavPoint, gx: number, gz: number): NavPoint[] | null {
    const c = this.cell
    interface Node { pt: NavPoint; g: number; f: number; parent: Node | null; key: string }
    const skey = (p: NavPoint) => `${Math.floor(p.x / c)},${Math.floor(p.z / c)},${this.nav.surfaceKey(p.surface)}`
    const open: Node[] = []
    const push = (n: Node) => {
      open.push(n)
      let i = open.length - 1
      while (i > 0) {
        const p = (i - 1) >> 1
        if (open[p]!.f <= open[i]!.f) break
        ;[open[p], open[i]] = [open[i]!, open[p]!]
        i = p
      }
    }
    const pop = (): Node => {
      const top = open[0]!
      const last = open.pop()!
      if (open.length > 0) {
        open[0] = last
        let i = 0
        for (;;) {
          const l = 2 * i + 1
          const r = l + 1
          let m = i
          if (l < open.length && open[l]!.f < open[m]!.f) m = l
          if (r < open.length && open[r]!.f < open[m]!.f) m = r
          if (m === i) break
          ;[open[m], open[i]] = [open[i]!, open[m]!]
          i = m
        }
      }
      return top
    }
    const best = new Map<string, number>()
    const h = (p: NavPoint) => Math.hypot(p.x - gx, p.z - gz)
    const start: Node = { pt: from, g: 0, f: h(from), parent: null, key: 'start' }
    push(start)
    let expansions = 0
    while (open.length > 0 && expansions < 30_000) {
      const n = pop()
      if ((best.get(n.key) ?? Infinity) < n.g) continue
      expansions++
      if (h(n.pt) <= c * 2 && this.clear(n.pt, gx, gz)) {
        const pts: NavPoint[] = [{ x: gx, y: 0, z: gz, surface: null }]
        for (let m: Node | null = n; m; m = m.parent) pts.push(m.pt)
        return pts.reverse()
      }
      const ix = Math.floor(n.pt.x / c)
      const iz = Math.floor(n.pt.z / c)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue
          const cx = (ix + dx + 0.5) * c
          const cz = (iz + dz + 0.5) * c
          const to = this.clear(n.pt, cx, cz)
          if (!to) continue
          const g = n.g + Math.hypot(cx - n.pt.x, cz - n.pt.z)
          const key = skey(to)
          if ((best.get(key) ?? Infinity) <= g) continue
          best.set(key, g)
          push({ pt: to, g, f: g + h(to), parent: n, key })
        }
      }
    }
    return null
  }
}
