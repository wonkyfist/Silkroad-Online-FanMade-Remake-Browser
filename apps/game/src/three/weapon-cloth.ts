/**
 * Real cloth for the weapons' banners, ribbons, streamers and tassels (docs/RARITY.md §6.2; pure, the tests read it).
 * The retail meshes model these parts sticking out stiffly; a wave around that pose can never read as fabric. Near
 * weapons run a position-based (verlet + PBD) particle sim per swaying part instead:
 *  - particles are the part's subdivided vertices welded by position (weapon-sway-parts.ts subdivideParts); the ones
 *    at the attachment end (sway weight ≈ 0) are pinned to the weapon and follow its world matrix (interpolated across
 *    substeps, so a swing whips the cloth);
 *  - distance constraints along every edge, weak bending constraints across every pair of neighbouring triangles,
 *    and a tether to the nearest pin (no stretch even with few iterations);
 *  - gravity (it hangs and drapes at rest), the weather's wind with gusts and travelling turbulence, and an
 *    aerodynamic force per triangle from its normal against the relative wind (so it streams when running, flaps and
 *    flutters); light damping; collision with the weapon's shaft (a capsule) and the ground under the owner.
 * Fixed 60 Hz steps (an accumulator, at most MAX_STEPS per frame), all state in pooled typed arrays.
 */

/** Fixed step (s), constraint iterations, the most steps one frame may take (the rest of the time is dropped). */
export const CLOTH_H = 1 / 60
export const CLOTH_ITERS = 3
export const MAX_STEPS = 3
/** Gravity (m/s²), cloth areal density (kg/m², a light silk), pressure coefficient 0.5 ρ_air Cd. */
const G = 9.81
const RHO = 0.14
const PRESSURE = 0.5 * 1.2 * 1.1
/** Velocity kept per step (verlet damping) and the acceleration cap (m/s², stability). */
const KEEP = 0.992
const ACC_MAX = 260

export interface ClothModel {
  /** Particles. */
  n: number
  /** Rest positions (mesh-local), 3 per particle. */
  rest: Float32Array
  /** 0 pinned, else 1 / mass. */
  invMass: Float32Array
  /** Pinned particle ids. */
  pins: Int32Array
  /** Edges (pairs) and rest lengths. */
  edges: Int32Array
  edgeRest: Float32Array
  /** Bends (pairs of the opposite corners of neighbouring triangles), rest lengths, stiffness 0..1. */
  bends: Int32Array
  bendRest: Float32Array
  bendK: Float32Array
  /** Per particle: its nearest pin and the rest distance to it (the tether). */
  tetherPin: Int32Array
  tetherLen: Float32Array
  /** Aero triangles (particle ids, double-sided duplicates dropped). */
  tris: Int32Array
  /** Per mesh vertex: its particle, or -1 (not cloth). */
  vertParticle: Int32Array
  /** The cloth vertices and the cloth triangles (mesh vertex ids, for normals). */
  clothVerts: Int32Array
  clothTris: Int32Array
  /** The weapon's shaft: a capsule (mesh-local ends, radius). */
  shaftA: [number, number, number]
  shaftB: [number, number, number]
  shaftR: number
  /** Phase per particle (turbulence offset). */
  phase: Float32Array
  /** +1 when the mesh's normals are u × v of its triangles (glTF, counter-clockwise), −1 the other winding. */
  normalSign: number
}

/**
 * Builds the cloth of a mesh from its (already subdivided) positions, indices and SWAY_KIND data (4 floats per
 * vertex: weight, phase, length, stiffness). Null when the mesh has no swaying part.
 */
export function buildCloth(pos: ArrayLike<number>, idx: ArrayLike<number>, sway: ArrayLike<number>, nrm?: ArrayLike<number> | null): ClothModel | null {
  const nv = Math.floor(pos.length / 3)
  const isCloth = (v: number) => sway[v * 4 + 2]! > 0
  // weld by position
  const vertParticle = new Int32Array(nv).fill(-1)
  const keyOf = new Map<string, number>()
  const restL: number[] = []
  const wOf: number[] = []
  const kOf: number[] = []
  const phOf: number[] = []
  const clothVerts: number[] = []
  for (let v = 0; v < nv; v++) {
    if (!isCloth(v)) continue
    clothVerts.push(v)
    const k = `${Math.round(pos[3 * v]! * 1e4)},${Math.round(pos[3 * v + 1]! * 1e4)},${Math.round(pos[3 * v + 2]! * 1e4)}`
    let p = keyOf.get(k)
    if (p === undefined) {
      keyOf.set(k, (p = restL.length / 3))
      restL.push(pos[3 * v]!, pos[3 * v + 1]!, pos[3 * v + 2]!)
      wOf.push(sway[v * 4]!)
      kOf.push(sway[v * 4 + 3]!)
      phOf.push(sway[v * 4 + 1]!)
    }
    vertParticle[v] = p
  }
  const n = restL.length / 3
  if (!n) return null
  const rest = Float32Array.from(restL)
  const dist = (a: number, b: number) => Math.hypot(rest[3 * a]! - rest[3 * b]!, rest[3 * a + 1]! - rest[3 * b + 1]!, rest[3 * a + 2]! - rest[3 * b + 2]!)
  // triangles: cloth (mesh vertex ids) and aero (particle ids, unique sets); edges with their triangles' opposite corners
  const clothTris: number[] = []
  const tris: number[] = []
  const triSeen = new Set<string>()
  const edgeOpp = new Map<string, number[]>()
  const area = new Float64Array(n)
  let facing = 0
  let rmin = [Infinity, Infinity, Infinity], rmax = [-Infinity, -Infinity, -Infinity]
  for (let v = 0; v < nv; v++) {
    if (isCloth(v)) continue
    for (let a = 0; a < 3; a++) {
      rmin[a] = Math.min(rmin[a]!, pos[3 * v + a]!)
      rmax[a] = Math.max(rmax[a]!, pos[3 * v + a]!)
    }
  }
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const va = idx[t]!, vb = idx[t + 1]!, vc = idx[t + 2]!
    if (!isCloth(va) || !isCloth(vb) || !isCloth(vc)) continue
    clothTris.push(va, vb, vc)
    if (nrm) {
      const ux = pos[3 * vb]! - pos[3 * va]!, uy = pos[3 * vb + 1]! - pos[3 * va + 1]!, uz = pos[3 * vb + 2]! - pos[3 * va + 2]!
      const wx = pos[3 * vc]! - pos[3 * va]!, wy = pos[3 * vc + 1]! - pos[3 * va + 1]!, wz = pos[3 * vc + 2]! - pos[3 * va + 2]!
      facing += (uy * wz - uz * wy) * nrm[3 * va]! + (uz * wx - ux * wz) * nrm[3 * va + 1]! + (ux * wy - uy * wx) * nrm[3 * va + 2]!
    }
    const a = vertParticle[va]!, b = vertParticle[vb]!, c = vertParticle[vc]!
    if (a === b || b === c || a === c) continue
    const key = [a, b, c].sort((x, y) => x - y).join(',')
    if (triSeen.has(key)) continue
    triSeen.add(key)
    tris.push(a, b, c)
    const ux = rest[3 * b]! - rest[3 * a]!, uy = rest[3 * b + 1]! - rest[3 * a + 1]!, uz = rest[3 * b + 2]! - rest[3 * a + 2]!
    const wx = rest[3 * c]! - rest[3 * a]!, wy = rest[3 * c + 1]! - rest[3 * a + 1]!, wz = rest[3 * c + 2]! - rest[3 * a + 2]!
    const ar = 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx)
    area[a] += ar / 3
    area[b] += ar / 3
    area[c] += ar / 3
    for (const [p, q, o] of [[a, b, c], [b, c, a], [c, a, b]] as const) {
      const ek = p < q ? `${p},${q}` : `${q},${p}`
      let l = edgeOpp.get(ek)
      if (!l) edgeOpp.set(ek, (l = []))
      l.push(o)
    }
  }
  const edges: number[] = []
  const edgeRest: number[] = []
  const bends: number[] = []
  const bendRest: number[] = []
  const bendK: number[] = []
  const bendSeen = new Set<string>()
  for (const [ek, opp] of edgeOpp) {
    const [p, q] = ek.split(',').map(Number) as [number, number]
    edges.push(p, q)
    edgeRest.push(dist(p, q))
    for (let i = 0; i < opp.length; i++) for (let j = i + 1; j < opp.length; j++) {
      const o1 = opp[i]!, o2 = opp[j]!
      if (o1 === o2) continue
      const bk = o1 < o2 ? `${o1},${o2}` : `${o2},${o1}`
      if (bendSeen.has(bk)) continue
      bendSeen.add(bk)
      bends.push(o1, o2)
      bendRest.push(dist(o1, o2))
      // fabric bends easily; a plume or a cord (stiffness → 1) keeps more of its shape
      const s = (kOf[o1]! + kOf[o2]!) / 2
      bendK.push(Math.min(0.6, Math.max(0.04, (s - 0.35) * 0.5)))
    }
  }
  // islands (union-find over the edges): each pins its attachment end (the lowest sway weight)
  const par = Int32Array.from({ length: n }, (_, i) => i)
  const find = (a: number): number => {
    while (par[a] !== a) a = par[a] = par[par[a]!]!
    return a
  }
  for (let e = 0; e < edges.length; e += 2) {
    const a = find(edges[e]!), b = find(edges[e + 1]!)
    if (a !== b) par[a] = b
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    let g = groups.get(r)
    if (!g) groups.set(r, (g = []))
    g.push(i)
  }
  const invMass = new Float32Array(n)
  const pins: number[] = []
  const tetherPin = new Int32Array(n).fill(-1)
  const tetherLen = new Float32Array(n)
  for (const g of groups.values()) {
    let lo = Infinity
    for (const i of g) lo = Math.min(lo, wOf[i]!)
    let pinned = g.filter(i => wOf[i]! <= lo + 0.035)
    if (pinned.length < 2 && g.length > 2) pinned = [...g].sort((a, b) => wOf[a]! - wOf[b]!).slice(0, 2)
    const set = new Set(pinned)
    for (const i of g) {
      if (set.has(i)) {
        pins.push(i)
        tetherPin[i] = i
        continue
      }
      invMass[i] = 1 / Math.max(1e-5, area[i]! * RHO)
      let best = Infinity
      for (const p of pinned) {
        const d = dist(i, p)
        if (d < best) {
          best = d
          tetherPin[i] = p
        }
      }
      tetherLen[i] = best
    }
  }
  // the shaft: the rigid body's longest box axis through the box centre, as thick as its thinner half-extent
  let shaftA: [number, number, number] = [0, 0, 0], shaftB: [number, number, number] = [0, 0, 0], shaftR = 0
  if (rmin[0]! < Infinity) {
    const ext = [0, 1, 2].map(a => rmax[a]! - rmin[a]!)
    const ax = ext.indexOf(Math.max(...ext))
    const c = [0, 1, 2].map(a => (rmax[a]! + rmin[a]!) / 2) as [number, number, number]
    shaftA = [...c]
    shaftB = [...c]
    shaftA[ax] = rmin[ax]!
    shaftB[ax] = rmax[ax]!
    const others = ext.filter((_, a) => a !== ax)
    shaftR = Math.max(0.01, Math.min(0.03, Math.min(...others) / 2))
    // never thicker than where the cloth already sits at rest (a box axis is only roughly the shaft)
    const bx = shaftB[0] - shaftA[0], by = shaftB[1] - shaftA[1], bz = shaftB[2] - shaftA[2]
    const bb = bx * bx + by * by + bz * bz
    for (let i = 0; i < n && bb > 1e-8; i++) {
      if (!invMass[i]) continue
      const px = rest[3 * i]! - shaftA[0], py = rest[3 * i + 1]! - shaftA[1], pz = rest[3 * i + 2]! - shaftA[2]
      const s = Math.max(0, Math.min(1, (px * bx + py * by + pz * bz) / bb))
      const d = Math.hypot(px - bx * s, py - by * s, pz - bz * s)
      shaftR = Math.min(shaftR, d * 0.8 - 0.006)
    }
    if (shaftR < 0.004) shaftR = 0
  }
  return {
    n,
    rest,
    invMass,
    pins: Int32Array.from(pins),
    edges: Int32Array.from(edges),
    edgeRest: Float32Array.from(edgeRest),
    bends: Int32Array.from(bends),
    bendRest: Float32Array.from(bendRest),
    bendK: Float32Array.from(bendK),
    tetherPin,
    tetherLen,
    tris: Int32Array.from(tris),
    vertParticle,
    clothVerts: Int32Array.from(clothVerts),
    clothTris: Int32Array.from(clothTris),
    shaftA,
    shaftB,
    shaftR,
    phase: Float32Array.from(phOf),
    normalSign: facing < 0 ? -1 : 1,
  }
}

/** The world the cloth lives in for one frame. */
export interface ClothEnv {
  /** Wind direction (unit, xz) and speed (m/s, gusts included by the weather). */
  windX: number
  windZ: number
  windMs: number
  /** Seconds (turbulence clock). */
  time: number
  /** The ground under the owner (world y), or -Infinity. */
  groundY: number
  /** The owner's body (world; absent: none). */
  body?: ClothBody | null
}

/** Babylon matrices (row-vector convention: m[12..14] the translation). */
type M16 = ArrayLike<number>

function xf(m: M16, x: number, y: number, z: number, out: Float32Array | Float64Array, o: number): void {
  out[o] = x * m[0]! + y * m[4]! + z * m[8]! + m[12]!
  out[o + 1] = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!
  out[o + 2] = x * m[2]! + y * m[6]! + z * m[10]! + m[14]!
}

/** One running cloth (one worn mesh near the camera); its arrays are allocated once. */
export class ClothSim {
  readonly x: Float64Array
  readonly xp: Float64Array
  private readonly acc: Float64Array
  /** Pin targets at the start and end of this frame (world). */
  private readonly pin0: Float64Array
  private readonly pin1: Float64Array
  private readonly shaft = new Float64Array(6)
  private carry = 0
  /** The world matrix's scale (the model is in mesh units; a worn weapon is scaled ×1.84 with its owner): rest lengths
   * × s, masses × s² (the aero force reads world areas). */
  private s = 1
  private inv2 = 1

  private scaleFrom(world: M16): void {
    const s = Math.sqrt(world[0]! * world[0]! + world[1]! * world[1]! + world[2]! * world[2]!) || 1
    this.s = s
    this.inv2 = 1 / (s * s)
  }
  /** Steps taken (stats). */
  steps = 0

  constructor(readonly model: ClothModel) {
    const n = model.n
    this.x = new Float64Array(n * 3)
    this.xp = new Float64Array(n * 3)
    this.acc = new Float64Array(n * 3)
    this.pin0 = new Float64Array(n * 3)
    this.pin1 = new Float64Array(n * 3)
  }

  /** Places the cloth at its rest shape under `world` (still). */
  reset(world: M16): void {
    this.scaleFrom(world)
    const { rest, n } = this.model
    for (let i = 0; i < n; i++) xf(world, rest[3 * i]!, rest[3 * i + 1]!, rest[3 * i + 2]!, this.x, 3 * i)
    this.xp.set(this.x)
    this.pin0.set(this.x)
    this.pin1.set(this.x)
    this.carry = 0
  }

  /**
   * Advances by `dt` seconds (fixed CLOTH_H steps, the remainder carried) with the weapon moving to `world`; the
   * pins move linearly from last frame's pose across the steps. Returns the steps taken.
   */
  advance(dt: number, world: M16, env: ClothEnv): number {
    this.scaleFrom(world)
    const { pins, rest } = this.model
    this.pin0.set(this.pin1)
    for (let k = 0; k < pins.length; k++) {
      const i = pins[k]!
      xf(world, rest[3 * i]!, rest[3 * i + 1]!, rest[3 * i + 2]!, this.pin1, 3 * i)
    }
    const m = this.model
    xf(world, m.shaftA[0], m.shaftA[1], m.shaftA[2], this.shaft, 0)
    xf(world, m.shaftB[0], m.shaftB[1], m.shaftB[2], this.shaft, 3)
    this.carry += Math.max(0, dt)
    let steps = Math.floor(this.carry / CLOTH_H)
    this.carry -= steps * CLOTH_H
    if (steps > MAX_STEPS) steps = MAX_STEPS
    for (let s = 1; s <= steps; s++) this.step(s / steps, env)
    if (!steps) {
      // no step this frame: the pins still follow (no lag of the attachment)
      for (let k = 0; k < pins.length; k++) {
        const o = 3 * pins[k]!
        this.x[o] = this.pin1[o]!
        this.x[o + 1] = this.pin1[o + 1]!
        this.x[o + 2] = this.pin1[o + 2]!
      }
    }
    this.steps += steps
    return steps
  }

  /** One fixed step; `f` 0..1 the pins' position between last frame's pose and this one's. */
  step(f: number, env: ClothEnv): void {
    const m = this.model
    const { n, invMass, tris, phase } = m
    const x = this.x, xp = this.xp, acc = this.acc
    const h = CLOTH_H
    // forces: gravity, then the wind on every triangle
    for (let i = 0; i < n; i++) {
      acc[3 * i] = 0
      acc[3 * i + 1] = -G
      acc[3 * i + 2] = 0
    }
    const t = env.time
    const ws = Math.max(1.2, env.windMs)
    const gust = 0.75 + 0.2 * Math.sin(t * 0.9) + 0.15 * Math.sin(t * 2.3 + 1.7) + 0.08 * Math.sin(t * 5.1)
    const base = ws * gust
    for (let k = 0; k < tris.length; k += 3) {
      const a = tris[k]!, b = tris[k + 1]!, c = tris[k + 2]!
      const ax = x[3 * a]!, ay = x[3 * a + 1]!, az = x[3 * a + 2]!
      const ux = x[3 * b]! - ax, uy = x[3 * b + 1]! - ay, uz = x[3 * b + 2]! - az
      const vx = x[3 * c]! - ax, vy = x[3 * c + 1]! - ay, vz = x[3 * c + 2]! - az
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const n2 = Math.sqrt(nx * nx + ny * ny + nz * nz)
      if (n2 < 1e-12) continue
      const ar = n2 / 2
      nx /= n2
      ny /= n2
      nz /= n2
      // the triangle's centre and velocity
      const cx = ax + (ux + vx) / 3, cy = ay + (uy + vy) / 3, cz = az + (uz + vz) / 3
      const tvx = (x[3 * a]! + x[3 * b]! + x[3 * c]! - xp[3 * a]! - xp[3 * b]! - xp[3 * c]!) / (3 * h)
      const tvy = (x[3 * a + 1]! + x[3 * b + 1]! + x[3 * c + 1]! - xp[3 * a + 1]! - xp[3 * b + 1]! - xp[3 * c + 1]!) / (3 * h)
      const tvz = (x[3 * a + 2]! + x[3 * b + 2]! + x[3 * c + 2]! - xp[3 * a + 2]! - xp[3 * b + 2]! - xp[3 * c + 2]!) / (3 * h)
      // the wind here: gusts travelling downwind, swirls across and up (turbulence)
      const ph = phase[a]! * 6.2831853
      const along = cx * env.windX + cz * env.windZ
      const wave = Math.sin(along * 3.1 - t * (2.2 + ws * 0.35) + ph)
      const swirl = Math.sin(cx * 4.7 + cy * 3.3 - t * 3.9 + ph) + 0.6 * Math.sin(cz * 5.3 - cy * 4.1 + t * 5.7)
      const sp = base * (1 + 0.3 * wave)
      const wx = env.windX * sp - env.windZ * swirl * base * 0.28
      const wz = env.windZ * sp + env.windX * swirl * base * 0.28
      const wy = Math.sin(cy * 3.7 + cx * 2.1 + t * 4.3 + ph) * base * 0.22
      const rx = wx - tvx, ry = wy - tvy, rz = wz - tvz
      const vn = rx * nx + ry * ny + rz * nz
      // pressure on the face (double-sided: |vn| vn along the normal), skin drag along it
      const fp = PRESSURE * ar * vn * Math.abs(vn)
      const fd = 0.02 * ar
      const fx = (fp * nx + fd * (rx - vn * nx)) / 3
      const fy = (fp * ny + fd * (ry - vn * ny)) / 3
      const fz = (fp * nz + fd * (rz - vn * nz)) / 3
      const i2 = this.inv2
      let im = invMass[a]! * i2
      acc[3 * a] += fx * im
      acc[3 * a + 1] += fy * im
      acc[3 * a + 2] += fz * im
      im = invMass[b]! * i2
      acc[3 * b] += fx * im
      acc[3 * b + 1] += fy * im
      acc[3 * b + 2] += fz * im
      im = invMass[c]! * i2
      acc[3 * c] += fx * im
      acc[3 * c + 1] += fy * im
      acc[3 * c + 2] += fz * im
    }
    // integrate (verlet); the pins go to their place on the weapon's path
    const p0 = this.pin0, p1 = this.pin1
    const h2 = h * h
    for (let i = 0; i < n; i++) {
      const o = 3 * i
      if (invMass[i] === 0) {
        xp[o] = x[o]!
        xp[o + 1] = x[o + 1]!
        xp[o + 2] = x[o + 2]!
        x[o] = p0[o]! + (p1[o]! - p0[o]!) * f
        x[o + 1] = p0[o + 1]! + (p1[o + 1]! - p0[o + 1]!) * f
        x[o + 2] = p0[o + 2]! + (p1[o + 2]! - p0[o + 2]!) * f
        continue
      }
      let ax = acc[o]!, ay = acc[o + 1]!, az = acc[o + 2]!
      const al = Math.sqrt(ax * ax + ay * ay + az * az)
      if (al > ACC_MAX) {
        const s = ACC_MAX / al
        ax *= s
        ay *= s
        az *= s
      }
      const nxp = x[o]! + (x[o]! - xp[o]!) * KEEP + ax * h2
      const nyp = x[o + 1]! + (x[o + 1]! - xp[o + 1]!) * KEEP + ay * h2
      const nzp = x[o + 2]! + (x[o + 2]! - xp[o + 2]!) * KEEP + az * h2
      xp[o] = x[o]!
      xp[o + 1] = x[o + 1]!
      xp[o + 2] = x[o + 2]!
      x[o] = nxp
      x[o + 1] = nyp
      x[o + 2] = nzp
    }
    this.solve()
    this.collide(env.groundY, env.body)
  }

  private solve(): void {
    const m = this.model
    const { edges, edgeRest, bends, bendRest, bendK, invMass, tetherPin, tetherLen, n } = m
    const s = this.s
    const x = this.x
    for (let it = 0; it < CLOTH_ITERS; it++) {
      for (let e = 0, k = 0; e < edges.length; e += 2, k++) pair(x, invMass, edges[e]!, edges[e + 1]!, edgeRest[k]! * s, 1)
      for (let e = 0, k = 0; e < bends.length; e += 2, k++) pair(x, invMass, bends[e]!, bends[e + 1]!, bendRest[k]! * s, bendK[k]!)
    }
    // tethers: never farther from its pin than at rest (+2 %)
    for (let i = 0; i < n; i++) {
      const p = tetherPin[i]!
      if (invMass[i] === 0 || p < 0) continue
      const o = 3 * i, q = 3 * p
      const dx = x[o]! - x[q]!, dy = x[o + 1]! - x[q + 1]!, dz = x[o + 2]! - x[q + 2]!
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const max = tetherLen[i]! * s * 1.02
      if (d > max) {
        const s = max / d
        x[o] = x[q]! + dx * s
        x[o + 1] = x[q + 1]! + dy * s
        x[o + 2] = x[q + 2]! + dz * s
      }
    }
  }

  private collide(groundY: number, body?: ClothBody | null): void {
    const { n, invMass, shaftR } = this.model
    const x = this.x, xp = this.xp, sh = this.shaft
    const ax = sh[0]!, ay = sh[1]!, az = sh[2]!
    const bx = sh[3]! - ax, by = sh[4]! - ay, bz = sh[5]! - az
    const bb = bx * bx + by * by + bz * bz
    const r = shaftR * this.s + 0.006
    for (let i = 0; i < n; i++) {
      if (invMass[i] === 0) continue
      const o = 3 * i
      if (shaftR > 0 && bb > 1e-8) {
        const px = x[o]! - ax, py = x[o + 1]! - ay, pz = x[o + 2]! - az
        const s = Math.max(0, Math.min(1, (px * bx + py * by + pz * bz) / bb))
        const dx = px - bx * s, dy = py - by * s, dz = pz - bz * s
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d < r && d > 1e-6) {
          const k = (r - d) / d
          x[o] += dx * k
          x[o + 1] += dy * k
          x[o + 2] += dz * k
        }
      }
      // the owner's body: an upright capsule (the cloth falls round it, not through it)
      if (body && body.r > 0) {
        const y = x[o + 1]!
        if (y > body.y0 && y < body.y1) {
          const dx = x[o]! - body.x, dz = x[o + 2]! - body.z
          const d2 = dx * dx + dz * dz
          if (d2 < body.r * body.r && d2 > 1e-8) {
            const k = body.r / Math.sqrt(d2)
            x[o] = body.x + dx * k
            x[o + 2] = body.z + dz * k
          }
        }
      }
      if (x[o + 1]! < groundY) {
        x[o + 1] = groundY
        // friction: the ground holds it
        xp[o] = x[o]! - (x[o]! - xp[o]!) * 0.3
        xp[o + 2] = x[o + 2]! - (x[o + 2]! - xp[o + 2]!) * 0.3
        xp[o + 1] = groundY
      }
    }
  }

  /**
   * Writes the particles back into the mesh's own space: `pos` / `nrm` are the mesh's full vertex arrays (only the
   * cloth vertices change); `inv` the inverse of the mesh's world matrix.
   */
  writeBack(inv: M16, pos: Float32Array, nrm: Float32Array | null): void {
    const m = this.model
    const { clothVerts, vertParticle, clothTris } = m
    const x = this.x
    for (let k = 0; k < clothVerts.length; k++) {
      const v = clothVerts[k]!
      const p = vertParticle[v]!
      xf(inv, x[3 * p]!, x[3 * p + 1]!, x[3 * p + 2]!, pos, 3 * v)
    }
    if (!nrm) return
    for (let k = 0; k < clothVerts.length; k++) {
      const v = 3 * clothVerts[k]!
      nrm[v] = nrm[v + 1] = nrm[v + 2] = 0
    }
    for (let t = 0; t < clothTris.length; t += 3) {
      const a = 3 * clothTris[t]!, b = 3 * clothTris[t + 1]!, c = 3 * clothTris[t + 2]!
      const ux = pos[b]! - pos[a]!, uy = pos[b + 1]! - pos[a + 1]!, uz = pos[b + 2]! - pos[a + 2]!
      const vx = pos[c]! - pos[a]!, vy = pos[c + 1]! - pos[a + 1]!, vz = pos[c + 2]! - pos[a + 2]!
      const sg = m.normalSign
      const nx = (uy * vz - uz * vy) * sg, ny = (uz * vx - ux * vz) * sg, nz = (ux * vy - uy * vx) * sg
      for (const o of [a, b, c]) {
        nrm[o] += nx
        nrm[o + 1] += ny
        nrm[o + 2] += nz
      }
    }
    for (let k = 0; k < clothVerts.length; k++) {
      const v = 3 * clothVerts[k]!
      const l = Math.sqrt(nrm[v]! * nrm[v]! + nrm[v + 1]! * nrm[v + 1]! + nrm[v + 2]! * nrm[v + 2]!) || 1
      nrm[v] /= l
      nrm[v + 1] /= l
      nrm[v + 2] /= l
    }
  }
}

function pair(x: Float64Array, w: Float32Array, a: number, b: number, rest: number, k: number): void {
  const wa = w[a]!, wb = w[b]!
  const ws = wa + wb
  if (ws === 0) return
  const oa = 3 * a, ob = 3 * b
  const dx = x[ob]! - x[oa]!, dy = x[ob + 1]! - x[oa + 1]!, dz = x[ob + 2]! - x[oa + 2]!
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (d < 1e-9) return
  const c = ((d - rest) / (d * ws)) * k
  x[oa] += dx * c * wa
  x[oa + 1] += dy * c * wa
  x[oa + 2] += dz * c * wa
  x[ob] -= dx * c * wb
  x[ob + 1] -= dy * c * wb
  x[ob + 2] -= dz * c * wb
}

/** An upright capsule (world): the axis at x, z from y0 to y1, radius r. */
export interface ClothBody {
  x: number
  z: number
  y0: number
  y1: number
  r: number
}
