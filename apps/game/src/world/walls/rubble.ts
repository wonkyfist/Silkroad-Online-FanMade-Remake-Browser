/**
 * Siege of Jangan, layer 2: where the broken stone lies (docs/SIEGE.md §9.2), as pure, seeded data (view.ts draws it).
 *
 * - **Piles** (`pileLayout`): every downed third leaves a heap: a mound (`pileHeight`, low in the middle where people
 *   walk through, heaped against the broken ends) and its chunks of wall stone lying on it. Each chunk also knows where
 *   it sat in the wall (`from`), so the collapse animation drops it from there onto its resting place: the pieces fall
 *   and settle into the very pile that stays.
 * - **Teeth** (`teethLayout`): broken stone left sticking out of a standing third's end beside a gap (the cut face
 *   would otherwise be a clean vertical slice).
 * - **Edges** (`exposedEdges`): where a standing piece meets a downed third along a side.
 * - **Motion** (`fallPose`): a chunk's pose t seconds into the collapse (gravity, one small bounce, a tumble that
 *   settles into its resting rotation), written into caller-owned arrays (no allocation per frame).
 * Seeds come from the third's id, so every client builds the same pile.
 */
import { mulberry32, type WallsSegment, type WallsSideInfo } from '@sro/shared'
import { COLLAPSE, type WallTierTable } from './look.ts'

export interface ChunkPose {
  /** World position (m). */
  x: number
  y: number
  z: number
  /** Rotation quaternion (x, y, z, w). */
  q: [number, number, number, number]
}

export interface Chunk {
  /** Shape 0..2 and look (0 brick, 1 core): picks the mesh. */
  shape: number
  look: 0 | 1
  /** Scale per axis (m). */
  s: [number, number, number]
  /** Brightness tint (instance colour). */
  tint: number
  rest: ChunkPose
  /** Where it sat in the wall (the collapse starts here). */
  from: ChunkPose
  /** Seconds after the collapse starts that it lets go. */
  delay: number
}

/** A side's frame: along/across → world x, z. */
export function sideXZ(side: Pick<WallsSideInfo, 'axis'>, along: number, across: number): [number, number] {
  return side.axis === 'x' ? [along, across] : [across, along]
}

/** The wall body's depth (m) and the across coordinate of `w` metres outward from the inner face. */
export function depthOf(side: Pick<WallsSideInfo, 'outer' | 'inner'>): number {
  return Math.abs(side.outer - side.inner)
}
export const acrossAt = (side: Pick<WallsSideInfo, 'inner' | 'out'>, w: number) => side.inner + side.out * w

/** How far a pile spreads inside the inner face and outside the outer face (m). */
export const PILE_SPREAD = { inside: 5, outside: 8, ends: 1.5 } as const
/** Mound heights (m): along the middle (where people walk through), against a broken end, and the peak's place across. */
export const PILE_HEIGHT = { middle: 1.4, ends: 3.6, crest: 0.55 } as const

/**
 * The mound's height at (u along the third 0..1, w outward from the inner face in m); 0 outside the footprint. A low
 * walkway in the middle, heaps toward both ends (against the standing stone), the crest a little outward of centre
 * (the wall fell outward as much as in).
 */
export function pileHeight(u: number, w: number, depth: number): number {
  const w0 = -PILE_SPREAD.inside, w1 = depth + PILE_SPREAD.outside
  if (w <= w0 || w >= w1) return 0
  const crest = depth * PILE_HEIGHT.crest
  const across = w < crest ? (w - w0) / (crest - w0) : (w1 - w) / (w1 - crest)
  const bell = Math.sin((Math.PI / 2) * Math.max(0, Math.min(1, across)))
  const end = Math.max(Math.exp(-((u / 0.2) ** 2)), Math.exp(-(((1 - u) / 0.2) ** 2)))
  return bell * (PILE_HEIGHT.middle + (PILE_HEIGHT.ends - PILE_HEIGHT.middle) * end)
}

/** FNV-1a of an id (a stable seed). */
export function seedOf(id: string, salt = 0): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Ground height (m) at a world point (NaN: unknown, the wall's base is used). */
export type GroundAt = (x: number, z: number) => number

/** The pile of one downed third: `tier.pileChunks` chunks on its mound, each with its place in the wall. */
export function pileLayout(seg: WallsSegment, third: number, side: WallsSideInfo, ground: GroundAt, tier: Pick<WallTierTable, 'pileChunks'>): Chunk[] {
  const t = seg.thirds[third]!
  const rnd = mulberry32(seedOf(t.id, 0x51e9e))
  const depth = depthOf(side)
  const base = side.placement.position[1]
  const groundOr = (x: number, z: number) => {
    const g = ground(x, z)
    return Number.isFinite(g) ? g : base
  }
  const out: Chunk[] = []
  for (let i = 0; i < tier.pileChunks; i++) {
    // over the whole heap, a little more toward the broken ends and its crest
    const r = rnd()
    const u = r < 0.5 ? (r * 2) ** 1.4 * 0.5 : 1 - ((1 - r) * 2) ** 1.4 * 0.5
    const span = depth + PILE_SPREAD.outside + PILE_SPREAD.inside
    const spread = 0.5 + 0.8 * ((rnd() + rnd() + rnd()) / 1.5 - 1)
    const w = -PILE_SPREAD.inside + span * Math.max(0.03, Math.min(0.97, spread))
    const along = t.from - PILE_SPREAD.ends * 0.5 + (t.to - t.from + PILE_SPREAD.ends) * u
    const [x, z] = sideXZ(side, along, acrossAt(side, w))
    const big = rnd() < 0.12
    const size = big ? 2 + rnd() * 1.4 : 0.6 + rnd() * rnd() * 1.6
    const s: [number, number, number] = [size * (0.8 + rnd() * 0.6), size * (big ? 0.45 + rnd() * 0.3 : 0.6 + rnd() * 0.5), size * (0.8 + rnd() * 0.5)]
    const h = pileHeight(Math.max(0, Math.min(1, (along - t.from) / (t.to - t.from))), w, depth)
    // half sunk into the heap
    const y = groundOr(x, z) + h + s[1] * (0.15 + rnd() * 0.2)
    const yaw = rnd() * Math.PI * 2
    const tilt = big ? 0.25 : 0.7
    const rest: ChunkPose = { x, y, z, q: euler((rnd() - 0.5) * tilt, yaw, (rnd() - 0.5) * tilt) }
    // its place in the standing wall: same spot along, inside the body, anywhere up the face
    const wIn = Math.max(0.8, Math.min(depth - 0.8, w))
    const [fx, fz] = sideXZ(side, Math.max(t.from + 0.5, Math.min(t.to - 0.5, along)), acrossAt(side, wIn))
    const hFrac = rnd()
    const fy = base + 1 + hFrac * Math.max(1, side.walkY - base - 2.5)
    const from: ChunkPose = { x: fx, y: Math.max(fy, y + 0.5), z: fz, q: euler(0, side.axis === 'x' ? 0 : Math.PI / 2, 0) }
    out.push({
      shape: Math.floor(rnd() * 3),
      look: rnd() < 0.3 ? 1 : 0,
      s,
      tint: 0.72 + rnd() * 0.33,
      rest,
      from,
      // the face peels from the top: high stone lets go first
      delay: (1 - hFrac) * COLLAPSE.stagger * (0.55 + 0.45 * rnd()),
    })
  }
  return out
}

/** A standing piece's end that faces a downed third. `dir` points from the standing stone into the gap along the axis. */
export interface Edge {
  side: WallsSideInfo
  /** Along the axis (m). */
  at: number
  dir: 1 | -1
  /** Seed id (the standing third's id, or the fixed piece's, plus the end). */
  id: string
}

/**
 * The ends of standing stone beside downed thirds, per side: thirds in order along the axis, joined to their neighbours
 * (the next segment's third, or a fixed piece: gatehouse, corner) when they touch (within 1 m).
 */
export function exposedEdges(
  sides: readonly WallsSideInfo[], segments: readonly WallsSegment[], down: (thirdId: string) => boolean,
): Edge[] {
  const out: Edge[] = []
  for (const side of sides) {
    const spans: { id: string; from: number; to: number; down: boolean }[] = []
    for (const seg of segments) {
      if (seg.side !== side.side) continue
      for (const t of seg.thirds) spans.push({ id: t.id, from: t.from, to: t.to, down: down(t.id) })
    }
    for (const f of side.fixed) spans.push({ id: f.id, from: f.from, to: f.to, down: false })
    spans.sort((a, b) => a.from - b.from)
    for (let i = 0; i + 1 < spans.length; i++) {
      const a = spans[i]!, b = spans[i + 1]!
      if (Math.abs(b.from - a.to) > 1 || a.down === b.down) continue
      if (a.down) out.push({ side, at: b.from, dir: -1, id: `${b.id}<` })
      else out.push({ side, at: a.to, dir: 1, id: `${a.id}>` })
    }
  }
  return out
}

/**
 * The broken end of a standing third beside a gap (the spec's `broken_l` / `broken_r`, made at run time): how far
 * (m, back from the cut along the axis) the end's vertices are pulled at height fraction `h` (0 the foot, 1 the wall
 * walk): nothing below a third of the height, then a ragged slope back to NOTCH.depth at the top, so a breach opens as
 * a V. `seed` gives each end its own ragged line; `w` (0..1 across the body) leans the slope a little.
 */
export const NOTCH = { depth: 5.5, from: 0.3 } as const

export function notchShift(h: number, w: number, seed: number): number {
  // each end breaks its own way: where the slope starts (0.18..0.48 of the height) and how deep it goes (0.55..1.2)
  const from = NOTCH.from - 0.12 + ((seed & 0xff) / 255) * 0.3
  const depth = NOTCH.depth * (0.55 + (((seed >>> 8) & 0xff) / 255) * 0.65)
  const t = Math.max(0, Math.min(1, (h - from) / (1 - from)))
  if (t <= 0) return 0
  // a ragged profile: a rise that steepens toward the top, a seeded wobble per height band, a lean across the body
  const band = Math.floor(h * 7)
  const wobble = ((((seed >>> 16) ^ (band * 2654435761)) >>> 0) % 8 / 7 - 0.5) * 0.5
  const lean = (w - 0.5) * (((seed >>> 24) & 1) ? 0.35 : -0.35)
  return depth * Math.max(0, Math.min(1.2, t ** 1.6 + wobble * t + lean * t))
}

/**
 * Broken stone sticking out of a standing end into the gap, along its notch (static, no fall). `back(h, w)` is how far
 * the end really stands back at that height (the notched mesh's own profile; default the ideal `notchShift`).
 */
export function teethLayout(edge: Edge, ground: GroundAt, tier: Pick<WallTierTable, 'teeth'>, back?: (h: number, wf: number) => number): Chunk[] {
  const side = edge.side
  const rnd = mulberry32(seedOf(edge.id, 0x7ee7))
  const seed = seedOf(edge.id, 0x7c4)
  const depth = depthOf(side)
  const base = side.placement.position[1]
  const out: Chunk[] = []
  for (let i = 0; i < tier.teeth; i++) {
    // on the two faces' broken edges (the silhouette seen from the field and from the town)
    const wf = rnd() < 0.5 ? 0.03 + rnd() * 0.14 : 0.83 + rnd() * 0.14
    const w = wf * depth
    // up the broken face, half sunk into its slope: low ones in the heap, high ones on the notch
    const hFrac = 0.08 + ((i + rnd()) / tier.teeth) * 0.86
    const b = back ? back(hFrac, wf) : notchShift(hFrac, wf, seed)
    const [x, z] = sideXZ(side, edge.at - edge.dir * b + edge.dir * (rnd() - 0.75) * 1.2, acrossAt(side, w))
    const g = ground(x, z)
    const y = (Number.isFinite(g) ? g : base) + 1 + hFrac * Math.max(2, side.walkY - base - 2)
    const size = 1.3 + rnd() * 1.6
    const rest: ChunkPose = { x, y, z, q: euler((rnd() - 0.5) * 0.7, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.7) }
    out.push({ shape: Math.floor(rnd() * 3), look: 0, s: [size, size * (0.6 + rnd() * 0.5), size * (0.8 + rnd() * 0.4)], tint: 0.8 + rnd() * 0.2, rest, from: rest, delay: 0 })
  }
  return out
}

// ---- motion ---------------------------------------------------------------------------------------------------------

/** How long a chunk's fall lasts (s, without its delay): the drop, then one bounce. */
export function fallDuration(c: Chunk): number {
  const drop = Math.max(0, c.from.y - c.rest.y)
  const tFall = Math.sqrt((2 * drop) / COLLAPSE.gravity)
  const vImpact = COLLAPSE.gravity * tFall
  const vb = Math.min(2.5, COLLAPSE.bounce * vImpact)
  return tFall + (2 * vb) / COLLAPSE.gravity
}

/**
 * A chunk's pose `t` seconds after its collapse began, written into `out` (position) and `q` (quaternion). Before its
 * delay it sits in the wall; then it drops under gravity while drifting to its resting spot and tumbling into its resting
 * rotation, hits the heap, hops once and lies still. Returns true once it rests.
 */
export function fallPose(c: Chunk, t: number, out: { x: number; y: number; z: number }, q: [number, number, number, number]): boolean {
  const tt = t - c.delay
  if (tt <= 0) {
    out.x = c.from.x
    out.y = c.from.y
    out.z = c.from.z
    copyQ(c.from.q, q)
    return false
  }
  const drop = Math.max(0, c.from.y - c.rest.y)
  const tFall = Math.sqrt((2 * drop) / COLLAPSE.gravity)
  const vb = Math.min(2.5, COLLAPSE.bounce * COLLAPSE.gravity * tFall)
  const tHop = (2 * vb) / COLLAPSE.gravity
  if (tt >= tFall + tHop) {
    out.x = c.rest.x
    out.y = c.rest.y
    out.z = c.rest.z
    copyQ(c.rest.q, q)
    return true
  }
  if (tt < tFall) {
    const k = tFall > 0 ? tt / tFall : 1
    // drift: slow at first (it slides off the face), quick at the end
    const s = k * k * (3 - 2 * k)
    out.x = c.from.x + (c.rest.x - c.from.x) * s
    out.z = c.from.z + (c.rest.z - c.from.z) * s
    out.y = c.from.y - 0.5 * COLLAPSE.gravity * tt * tt
    slerp(c.from.q, c.rest.q, Math.min(1, k * 1.15), q)
  } else {
    const th = tt - tFall
    out.x = c.rest.x
    out.z = c.rest.z
    out.y = c.rest.y + vb * th - 0.5 * COLLAPSE.gravity * th * th
    copyQ(c.rest.q, q)
  }
  return false
}

// ---- small quaternion helpers (no allocation in the per-frame path) -------------------------------------------------

/** Quaternion of rotations about x (pitch), y (yaw), z (roll), applied yaw · pitch · roll. */
export function euler(pitch: number, yaw: number, roll: number): [number, number, number, number] {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2)
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2)
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2)
  return [cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr, cy * cp * sr - sy * sp * cr, cy * cp * cr + sy * sp * sr]
}

function copyQ(a: readonly number[], out: number[]): void {
  out[0] = a[0]!
  out[1] = a[1]!
  out[2] = a[2]!
  out[3] = a[3]!
}

export function slerp(a: readonly number[], b: readonly number[], t: number, out: number[]): void {
  let bx = b[0]!, by = b[1]!, bz = b[2]!, bw = b[3]!
  let d = a[0]! * bx + a[1]! * by + a[2]! * bz + a[3]! * bw
  if (d < 0) {
    d = -d
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let ka: number, kb: number
  if (d > 0.9995) {
    ka = 1 - t
    kb = t
  } else {
    const th = Math.acos(d)
    const s = Math.sin(th)
    ka = Math.sin((1 - t) * th) / s
    kb = Math.sin(t * th) / s
  }
  const x = a[0]! * ka + bx * kb, y = a[1]! * ka + by * kb, z = a[2]! * ka + bz * kb, w = a[3]! * ka + bw * kb
  const l = Math.hypot(x, y, z, w) || 1
  out[0] = x / l
  out[1] = y / l
  out[2] = z / l
  out[3] = w / l
}

/** Column-major 4×4 of translation · rotation · scale into `m` at `o` (Babylon's thin-instance matrix layout). */
export function composeInto(m: Float32Array, o: number, x: number, y: number, z: number, q: readonly number[], sx: number, sy: number, sz: number): void {
  const qx = q[0]!, qy = q[1]!, qz = q[2]!, qw = q[3]!
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz
  m[o] = (1 - 2 * (yy + zz)) * sx
  m[o + 1] = 2 * (xy + wz) * sx
  m[o + 2] = 2 * (xz - wy) * sx
  m[o + 3] = 0
  m[o + 4] = 2 * (xy - wz) * sy
  m[o + 5] = (1 - 2 * (xx + zz)) * sy
  m[o + 6] = 2 * (yz + wx) * sy
  m[o + 7] = 0
  m[o + 8] = 2 * (xz + wy) * sz
  m[o + 9] = 2 * (yz - wx) * sz
  m[o + 10] = (1 - 2 * (xx + yy)) * sz
  m[o + 11] = 0
  m[o + 12] = x
  m[o + 13] = y
  m[o + 14] = z
  m[o + 15] = 1
}
