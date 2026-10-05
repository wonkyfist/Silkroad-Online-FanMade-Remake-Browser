/**
 * The lightning bolt's shape (docs/WEATHER.md §7.3b): a fresh branching channel per strike, generated from the strike's
 * seed, so every client draws the same bolt. Pure (no Babylon): segments in world metres for the renderer (fx.ts).
 *
 * - **Main channel**: midpoint displacement of the line from the cloud point down to the impact (MAIN_DEPTH levels:
 *   2^MAIN_DEPTH segments), each midpoint pushed sideways by ROUGHNESS × the piece's length; the cloud point leans
 *   off the vertical by up to LEAN × the height, as real channels slant.
 * - **Forks**: FORKS[0..1] branches leave the main channel's upper 85 %, angled 20–55° off it and downward, each
 *   0.12–0.4 of the height long, displaced the same way (FORK_DEPTH levels); a fork may carry one sub-fork. Forks are
 *   dimmer and thinner than the main channel and fade toward their tips; they only show in the first return stroke.
 * - Widths and brightness are relative (0..1); the renderer scales widths with the camera distance.
 */
import { BOLT_CLOUD_M, mulberry32 } from '@sro/shared'

export type V3 = [number, number, number]

export interface BoltSegment {
  a: V3
  b: V3
  /** Relative width 0..1 (main channel ~1 at the ground). */
  width: number
  /** Relative brightness 0..1. */
  glow: number
  /** 0 = main channel, 1 = fork, 2 = sub-fork. */
  depth: number
}

export interface BoltShape {
  segments: BoltSegment[]
  /** The first `main` segments are the main channel, top to bottom. */
  main: number
  /** The cloud point the channel starts from. */
  top: V3
}

export const MAIN_DEPTH = 6
export const FORK_DEPTH = 4
export const SUB_DEPTH = 3
export const ROUGHNESS = 0.2
export const LEAN = 0.22
export const FORKS = [3, 7] as const
/** Most segments a bolt can have (the renderer's buffer size): the main channel, every fork and sub-fork. */
export const MAX_BOLT_SEGMENTS = 2 ** MAIN_DEPTH + FORKS[1] * (2 ** FORK_DEPTH + 2 ** SUB_DEPTH)

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const len = (v: V3) => Math.hypot(v[0], v[1], v[2])

/** A unit vector perpendicular to `d`, at a random angle around it. */
function perpendicular(d: V3, rng: () => number): V3 {
  const l = len(d) || 1
  const u: V3 = [d[0] / l, d[1] / l, d[2] / l]
  // any vector not parallel to u
  const h: V3 = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const p1: V3 = [u[1] * h[2] - u[2] * h[1], u[2] * h[0] - u[0] * h[2], u[0] * h[1] - u[1] * h[0]]
  const l1 = len(p1) || 1
  p1[0] /= l1
  p1[1] /= l1
  p1[2] /= l1
  const p2: V3 = [u[1] * p1[2] - u[2] * p1[1], u[2] * p1[0] - u[0] * p1[2], u[0] * p1[1] - u[1] * p1[0]]
  const a = rng() * Math.PI * 2
  return [p1[0] * Math.cos(a) + p2[0] * Math.sin(a), p1[1] * Math.cos(a) + p2[1] * Math.sin(a), p1[2] * Math.cos(a) + p2[2] * Math.sin(a)]
}

/** Midpoint displacement from `a` to `b`, `depth` levels: 2^depth + 1 points, the ends kept. */
export function displace(a: V3, b: V3, depth: number, roughness: number, rng: () => number): V3[] {
  let pts: V3[] = [a, b]
  for (let level = 0; level < depth; level++) {
    const next: V3[] = [pts[0]!]
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i]!
      const q = pts[i + 1]!
      const d = sub(q, p)
      const off = perpendicular(d, rng)
      const amt = (rng() * 2 - 1) * roughness * len(d)
      next.push([(p[0] + q[0]) / 2 + off[0] * amt, (p[1] + q[1]) / 2 + off[1] * amt, (p[2] + q[2]) / 2 + off[2] * amt], q)
    }
    pts = next
  }
  return pts
}

/**
 * The bolt of strike `seed` ending at `impact`, from a cloud point `height` metres above it (default BOLT_CLOUD_M).
 * Deterministic: the same seed and impact give the same segments on every client.
 */
export function generateBolt(seed: number, impact: V3, height = BOLT_CLOUD_M): BoltShape {
  const rng = mulberry32((seed ^ 0x2545f491) >>> 0)
  const ang = rng() * Math.PI * 2
  const lean = LEAN * height * Math.sqrt(rng())
  const top: V3 = [impact[0] + Math.cos(ang) * lean, impact[1] + height, impact[2] + Math.sin(ang) * lean]
  const main = displace(top, impact, MAIN_DEPTH, ROUGHNESS, rng)
  const segments: BoltSegment[] = []
  const n = main.length - 1
  for (let i = 0; i < n; i++) {
    const k = i / n
    // the channel widens a little toward the ground, and is brightest there
    segments.push({ a: main[i]!, b: main[i + 1]!, width: 0.75 + 0.25 * k, glow: 0.85 + 0.15 * k, depth: 0 })
  }
  const forks = FORKS[0] + Math.floor(rng() * (FORKS[1] - FORKS[0] + 1))
  for (let f = 0; f < forks; f++) {
    const i = Math.floor(rng() * n * 0.85)
    const from = main[i]!
    const dir = sub(main[Math.min(n, i + 1)]!, from)
    const forkLen = height * (0.12 + 0.28 * rng())
    branch(segments, from, dir, forkLen, 1, rng, 1 - i / n)
  }
  return { segments, main: n, top }
}

/** One fork from `from`, angled off `dir`, `length` metres; `room` (0..1) shrinks forks low on the channel. */
function branch(out: BoltSegment[], from: V3, dir: V3, length: number, depth: number, rng: () => number, room: number): void {
  const l = len(dir) || 1
  const u: V3 = [dir[0] / l, dir[1] / l, dir[2] / l]
  const side = perpendicular(u, rng)
  const tilt = (20 + 35 * rng()) * (Math.PI / 180)
  const d: V3 = [u[0] * Math.cos(tilt) + side[0] * Math.sin(tilt), u[1] * Math.cos(tilt) + side[1] * Math.sin(tilt), u[2] * Math.cos(tilt) + side[2] * Math.sin(tilt)]
  // forks run downward: never up
  if (d[1] > -0.25) d[1] = -0.25 - 0.3 * rng()
  const dl = len(d)
  const reach = length * (0.5 + 0.5 * room)
  const end: V3 = [from[0] + (d[0] / dl) * reach, from[1] + (d[1] / dl) * reach, from[2] + (d[2] / dl) * reach]
  const pts = displace(from, end, depth === 1 ? FORK_DEPTH : SUB_DEPTH, ROUGHNESS * 1.15, rng)
  const n = pts.length - 1
  const base = depth === 1 ? 0.55 : 0.35
  for (let i = 0; i < n; i++) {
    const k = i / n
    out.push({ a: pts[i]!, b: pts[i + 1]!, width: base * (1 - 0.7 * k), glow: (depth === 1 ? 0.6 : 0.4) * (1 - 0.75 * k), depth })
  }
  if (depth === 1 && rng() < 0.55) {
    const j = Math.floor(rng() * n * 0.7)
    branch(out, pts[j]!, sub(pts[j + 1]!, pts[j]!), length * 0.45, 2, rng, room)
  }
}

/**
 * Static for the telegraph (the air crackling before the strike): `count` short arcs of `size` metres around `centre`
 * within `radius`, re-drawn every few frames from `seed` (a new seed each time).
 */
export function staticArcs(seed: number, centre: V3, radius: number, count: number, size: number): BoltSegment[] {
  const rng = mulberry32(seed >>> 0)
  const out: BoltSegment[] = []
  for (let k = 0; k < count; k++) {
    const a = rng() * Math.PI * 2
    const r = radius * Math.sqrt(rng())
    const p: V3 = [centre[0] + Math.cos(a) * r, centre[1] + 0.05 + rng() * size * 0.6, centre[2] + Math.sin(a) * r]
    const q: V3 = [p[0] + (rng() - 0.5) * size, p[1] + rng() * size, p[2] + (rng() - 0.5) * size]
    const pts = displace(p, q, 2, 0.35, rng)
    for (let i = 0; i < pts.length - 1; i++) out.push({ a: pts[i]!, b: pts[i + 1]!, width: 0.3, glow: 0.5 + 0.5 * rng(), depth: 2 })
  }
  return out
}
