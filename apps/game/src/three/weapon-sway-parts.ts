/**
 * Which parts of a weapon move in the wind (docs/RARITY.md §6, pure: the loader, the tests and the lab read it).
 * Retail weapons are one mesh with one texture; their tassels, ribbons, banners, plumes and cords are separate
 * islands of that mesh (no shared vertex with the body): flat cards (zero thickness) or thin strips. Each island is
 * measured along its own principal axes (length L, width W, thickness T) and a part sways when it is
 *  - not structural (not the biggest island, not longer than half the weapon), and
 *  - a flat card (T ≤ 4 mm) at least twice as long as wide, or a thin strip (T ≤ 3 cm) at least 3× as long as wide
 *    and 12 cm long, or its material is named like cloth (tassel, ribbon, cloth, banner, flag, rope, string, cord).
 * Square-ish flat cards (metal wings, jewels, the fan of a glaive head) stay rigid. The pin is the end of the part
 * nearest the rest of the weapon (where it hangs from); the sway weight runs 0 there to 1 at the free end.
 * SWAY_OVERRIDES fixes the models the rule gets wrong (by glb name and the island's centre in the glTF's space).
 *
 * The vertex attribute (SWAY_KIND, 4 floats): x the weight 0..1 (0 = rigid), y the part's phase 0..1, z its length
 * (m, model space), w its stiffness (0.4 a light ribbon .. 1 a plume or a cord).
 */

export const SWAY_KIND = 'sroSway'

export interface SwayPart {
  /** Island index (sorted: vertex count desc, then centre z, y, x). */
  index: number
  verts: number
  length: number
  width: number
  thickness: number
  /** Why it sways: 'card', 'strip', 'name', 'override'. */
  reason: string
  /** Pin and free end (model space). */
  pin: [number, number, number]
  free: [number, number, number]
}

export interface SwayResult {
  /** 4 floats per vertex (SWAY_KIND); null when nothing sways. */
  data: Float32Array | null
  parts: SwayPart[]
  islands: number
  /** Centroid of the swaying parts (model space; the inertia probe). */
  centre: [number, number, number]
}

/** An island by its centre (model space, m; matched within SWAY_MATCH_M, so the optimized glbs match too). */
export type IslandAt = readonly [number, number, number]
export const SWAY_MATCH_M = 0.03

export interface SwayOverride {
  /** Islands that sway although the rule says rigid. */
  add?: readonly IslandAt[]
  /** Islands the rule picks that are rigid (metal ornaments). */
  drop?: readonly IslandAt[]
}

/**
 * Per-model fixes after the lab check (work/out/item/china/weapon; the D1-D8 Chinese weapons). Islands as listed by
 * `swayParts(...).parts` / the lab's crop sheet.
 */
// the rule's misses (solid tassels: spear_02-05, sword_08 plumes) and its rigid metal cards and spikes (ornaments,
// fins, arrowheads, blade wings)
export const SWAY_OVERRIDES: Readonly<Record<string, SwayOverride>> = {
  spear_02: { add: [[0.07, -0.01, 1.15]] },
  spear_03: { add: [[0.1, -0.01, 1.03]], drop: [[0.01, -0.01, -0.33]] },
  spear_04: { add: [[0.04, 0.02, 1.24]] },
  spear_05: { add: [[0.12, -0.01, 1.16]], drop: [[0.01, -0.01, -0.56], [0.01, -0.01, 1.95]] },
  spear_08: { drop: [[0.13, -0.02, 1.91], [-0.11, -0.02, 1.91]] },
  tblade_06: { drop: [[0.1, -0.02, 2.18], [-0.08, -0.02, 2.18]] },
  tblade_07: { drop: [[0.18, -0.04, 1.72], [0.18, -0.03, 1.72], [-0.18, -0.04, 1.72], [-0.18, -0.03, 1.72]] },
  sword_06: { drop: [[-0.01, -0.01, 0]] },
  sword_07: { drop: [[-0.01, -0.01, 0.11], [-0.01, -0.01, 0.24], [-0.1, -0.01, 0.11], [0.08, -0.01, 0.11]] },
  sword_08: { add: [[-0.13, -0.02, 0.25], [-0.13, -0.01, 0.25], [0.09, -0.02, 0.25], [0.09, -0.01, 0.25]], drop: [[-0.02, -0.01, 0.98], [-0.08, -0.02, 0.39], [0.04, -0.02, 0.39]] },
  blade_04: { drop: [[-0.01, -0.01, 0.08], [-0.01, -0.01, 0.2]] },
  blade_05: { drop: [[0.03, -0.02, 0.34], [-0.01, -0.02, 0.43]] },
  blade_08: { drop: [[-0.29, -0.02, 0.21]] },
  bow_03: { drop: [[0.04, 0, -0.46], [-0.04, 0, 0.45]] },
  bow_05: { drop: [[0, -0.01, -0.58], [0, -0.01, 0.58], [0.2, -0.01, -0.36], [0.2, -0.01, 0.36], [-0.11, -0.01, -0.68], [-0.07, -0.01, -0.63], [0.05, -0.01, -0.53], [0.1, -0.01, -0.46], [0.14, -0.01, -0.26], [0.14, -0.01, -0.19], [0.14, -0.01, 0.19], [0.14, -0.01, 0.26], [0.1, -0.01, 0.46], [0.05, -0.01, 0.53], [-0.07, -0.01, 0.63], [-0.11, -0.01, 0.68]] },
  bow_08: { drop: [[0.3, -0.01, -0.39], [0.3, -0.01, 0.39], [0.37, -0.01, -0.19], [0.37, -0.01, 0.19]] },
}

const CLOTH_NAME = /tassel|ribbon|cloth|banner|flag|rope|string|cord|feather|plume/i

/** The glb's base name (`.../spear_08.glb` → `spear_08`). */
export function swayModelName(glb: string): string {
  const m = /([^/\\]+?)(\.glb)?$/i.exec(glb)
  return (m?.[1] ?? glb).toLowerCase()
}

function hash01(a: number): number {
  const s = Math.sin(a * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

/** Principal axes of a point set (power iteration on the covariance): unit vectors, largest spread first. */
function axes(pts: Float64Array, n: number, c: [number, number, number]): [number[], number[], number[]] {
  const C = [0, 0, 0, 0, 0, 0] // xx xy xz yy yz zz
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i]! - c[0], y = pts[3 * i + 1]! - c[1], z = pts[3 * i + 2]! - c[2]
    C[0]! += x * x; C[1]! += x * y; C[2]! += x * z; C[3]! += y * y; C[4]! += y * z; C[5]! += z * z
  }
  const mul = (v: number[]): number[] => [C[0]! * v[0]! + C[1]! * v[1]! + C[2]! * v[2]!, C[1]! * v[0]! + C[3]! * v[1]! + C[4]! * v[2]!, C[2]! * v[0]! + C[4]! * v[1]! + C[5]! * v[2]!]
  const norm = (v: number[]): number[] => {
    const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1
    return [v[0]! / l, v[1]! / l, v[2]! / l]
  }
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  const power = (seed: number[], away: number[][]): number[] => {
    let v = norm(seed)
    for (let k = 0; k < 40; k++) {
      v = mul(v)
      for (const a of away) {
        const d = dot(v, a)
        v = [v[0]! - a[0]! * d, v[1]! - a[1]! * d, v[2]! - a[2]! * d]
      }
      const l = Math.hypot(v[0]!, v[1]!, v[2]!)
      if (l < 1e-12) break
      v = [v[0]! / l, v[1]! / l, v[2]! / l]
    }
    return v
  }
  let a0 = power([0.31, 0.47, 0.83], [])
  if (!isFinite(a0[0]!)) a0 = [0, 0, 1]
  let seed = Math.abs(a0[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  let a1 = power(seed, [a0])
  const cr = [a0[1]! * a1[2]! - a0[2]! * a1[1]!, a0[2]! * a1[0]! - a0[0]! * a1[2]!, a0[0]! * a1[1]! - a0[1]! * a1[0]!]
  if (Math.hypot(cr[0]!, cr[1]!, cr[2]!) < 0.5) {
    seed = [0, 0, 1]
    a1 = power(seed, [a0])
  }
  const a2 = norm([a0[1]! * a1[2]! - a0[2]! * a1[1]!, a0[2]! * a1[0]! - a0[0]! * a1[2]!, a0[0]! * a1[1]! - a0[1]! * a1[0]!])
  return [a0, a1, a2]
}

/**
 * The swaying parts of one weapon mesh: `positions` xyz per vertex, `indices` triangles, `material` its material
 * name, `model` the glb base name (SWAY_OVERRIDES).
 */
export function swayParts(positions: ArrayLike<number>, indices: ArrayLike<number>, model = '', material = ''): SwayResult {
  const n = Math.floor(positions.length / 3)
  // weld by position (the converter splits vertices at UV seams)
  const key = new Map<string, number>()
  const weld = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(positions[3 * i]! * 1e4)},${Math.round(positions[3 * i + 1]! * 1e4)},${Math.round(positions[3 * i + 2]! * 1e4)}`
    let w = key.get(k)
    if (w === undefined) key.set(k, (w = i))
    weld[i] = w
  }
  const par = Int32Array.from({ length: n }, (_, i) => i)
  const find = (a: number): number => {
    while (par[a] !== a) a = par[a] = par[par[a]!]!
    return a
  }
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = find(weld[indices[t]!]!)
    for (const o of [1, 2]) {
      const b = find(weld[indices[t + o]!]!)
      const ra = find(a)
      if (ra !== b) par[ra] = b
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(weld[i]!)
    let g = groups.get(r)
    if (!g) groups.set(r, (g = []))
    g.push(i)
  }
  // model extent along its longest box axis
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
    mn[a] = Math.min(mn[a]!, positions[3 * i + a]!)
    mx[a] = Math.max(mx[a]!, positions[3 * i + a]!)
  }
  const modelLen = Math.max(mx[0]! - mn[0]!, mx[1]! - mn[1]!, mx[2]! - mn[2]!)
  type Island = { vs: number[]; c: [number, number, number] }
  const islands: Island[] = [...groups.values()].map(vs => {
    const c: [number, number, number] = [0, 0, 0]
    for (const i of vs) for (let a = 0; a < 3; a++) c[a]! += positions[3 * i + a]! / vs.length
    return { vs, c }
  })
  islands.sort((a, b) => b.vs.length - a.vs.length || a.c[2] - b.c[2] || a.c[1] - b.c[1] || a.c[0] - b.c[0])
  const ov = SWAY_OVERRIDES[model] ?? {}
  const data = new Float32Array(n * 4)
  const parts: SwayPart[] = []
  const inIsland = new Int32Array(n)
  islands.forEach((isl, k) => {
    for (const i of isl.vs) inIsland[i] = k
  })
  const centre: [number, number, number] = [0, 0, 0]
  let centreN = 0
  islands.forEach((isl, k) => {
    const m = isl.vs.length
    const pts = new Float64Array(m * 3)
    isl.vs.forEach((i, j) => {
      pts[3 * j] = positions[3 * i]!
      pts[3 * j + 1] = positions[3 * i + 1]!
      pts[3 * j + 2] = positions[3 * i + 2]!
    })
    const [a0, a1, a2] = axes(pts, m, isl.c)
    const range = (ax: number[]) => {
      let lo = Infinity, hi = -Infinity
      for (let j = 0; j < m; j++) {
        const d = (pts[3 * j]! - isl.c[0]) * ax[0]! + (pts[3 * j + 1]! - isl.c[1]) * ax[1]! + (pts[3 * j + 2]! - isl.c[2]) * ax[2]!
        lo = Math.min(lo, d)
        hi = Math.max(hi, d)
      }
      return [lo, hi] as const
    }
    const [l0, l1] = range(a0)
    const [w0, w1] = range(a1)
    const [t0, t1] = range(a2)
    const L = l1 - l0, W = Math.max(1e-4, w1 - w0), T = t1 - t0
    const structural = k === 0 || L > modelLen * 0.5 || m < 3
    let reason = ''
    if (!structural) {
      if (T <= 0.004 && L >= 0.06 && L / W >= 2) reason = 'card'
      else if (T <= 0.03 && L >= 0.12 && L / W >= 3) reason = 'strip'
      else if (CLOTH_NAME.test(material) && L >= 0.06) reason = 'name'
    }
    const hit = (list: readonly IslandAt[] | undefined) => !!list?.some(p => Math.hypot(p[0] - isl.c[0], p[1] - isl.c[1], p[2] - isl.c[2]) <= SWAY_MATCH_M)
    if (hit(ov.drop)) reason = ''
    if (hit(ov.add) && !reason) reason = 'override'
    if (!reason) return
    // the pin: the end nearer the rest of the weapon
    const nearest = (end: number): number => {
      let best = Infinity
      for (let j = 0; j < m; j++) {
        const d = (pts[3 * j]! - isl.c[0]) * a0[0]! + (pts[3 * j + 1]! - isl.c[1]) * a0[1]! + (pts[3 * j + 2]! - isl.c[2]) * a0[2]!
        if (Math.abs(d - end) > L * 0.2) continue
        for (let i = 0; i < n; i++) {
          if (inIsland[i] === k) continue
          const dx = pts[3 * j]! - positions[3 * i]!, dy = pts[3 * j + 1]! - positions[3 * i + 1]!, dz = pts[3 * j + 2]! - positions[3 * i + 2]!
          const dd = dx * dx + dy * dy + dz * dz
          if (dd < best) best = dd
        }
      }
      return best
    }
    const pinLow = nearest(l0) <= nearest(l1)
    const pinD = pinLow ? l0 : l1
    const dir = pinLow ? 1 : -1
    const stiff = reason === 'card' ? (W > 0.08 ? 0.45 : 0.55) : T > 0.01 ? 0.9 : 0.7
    const phase = hash01(k * 7.13 + isl.c[0] * 31 + isl.c[2] * 17)
    for (const i of isl.vs) {
      const d = (positions[3 * i]! - isl.c[0]) * a0[0]! + (positions[3 * i + 1]! - isl.c[1]) * a0[1]! + (positions[3 * i + 2]! - isl.c[2]) * a0[2]!
      const w = Math.max(0, Math.min(1, ((d - pinD) * dir) / Math.max(1e-4, L)))
      data[4 * i] = w
      data[4 * i + 1] = phase
      data[4 * i + 2] = L
      data[4 * i + 3] = stiff
    }
    const at = (d: number): [number, number, number] => [isl.c[0] + a0[0]! * d, isl.c[1] + a0[1]! * d, isl.c[2] + a0[2]! * d]
    parts.push({ index: k, verts: m, length: L, width: W, thickness: T, reason, pin: at(pinD), free: at(pinLow ? l1 : l0) })
    for (let a = 0; a < 3; a++) centre[a]! += isl.c[a]! * m
    centreN += m
  })
  if (centreN) for (let a = 0; a < 3; a++) centre[a]! /= centreN
  return { data: parts.length ? data : null, parts, islands: islands.length, centre }
}

/** Display wind strength 0..1.4 of the weather's gusts (m/s): a light breeze always, storms stronger. */
export function swayStrength(gustMs: number): number {
  return Math.max(0.22, Math.min(1.4, gustMs / 14))
}

/**
 * The TS mirror of the vertex sway (tests): the world offset of a vertex of weight `w`, phase `ph`, part length `L`,
 * stiffness `k`, at `t` s in wind (dirX, dirZ) of strength `s`, on a card facing `normal`, plus the inertia lag.
 */
export function swayOffset(w: number, ph: number, L: number, k: number, t: number, dirX: number, dirZ: number, s: number, lag: readonly [number, number, number] = [0, 0, 0], normal: readonly [number, number, number] = [-dirZ, 0, dirX]): [number, number, number] {
  if (w <= 0) return [0, 0, 0]
  const l = L / Math.max(0.3, k)
  const a = ph * 6.2831853
  const gust = 0.6 + 0.25 * Math.sin(t * 1.3 + a) + 0.15 * Math.sin(t * 3.7 + a * 2)
  const rip = (Math.sin(t * (4 + 4 * s) + a - w * 7) + 0.45 * Math.sin(t * (7 + 5 * s) + a * 3 - w * 12)) * (0.13 + 0.12 * s) * gust
  const push = (0.12 + 0.3 * s) * gust
  const g = Math.pow(w, 1.6)
  const r = Math.pow(w, 1.2)
  return [
    l * (normal[0] * rip * r + dirX * push * g) + g * L * lag[0],
    l * (normal[1] * rip * r + 0.08 * s * gust * g) + g * L * lag[1],
    l * (normal[2] * rip * r + dirZ * push * g) + g * L * lag[2],
  ]
}

/** One vertex stream: its values and floats per vertex. */
export interface Stream {
  data: ArrayLike<number>
  stride: number
}

/**
 * Splits the triangles of the swaying parts so they bend along their length (pure, tests): a retail tassel or streamer
 * is a card of 4-6 vertices, which can only tilt; each pass cuts every triangle whose three vertices are all in a part
 * (`member(i)`) into four at its edge midpoints (shared per edge: no cracks). Every stream is interpolated (integer
 * streams such as skin indices take the first end's value); the rest of the mesh is untouched.
 */
export function subdivideParts(streams: Record<string, Stream>, indices: ArrayLike<number>, member: (i: number) => boolean, passes = 2, integer: (kind: string) => boolean = k => /indices/i.test(k)): { streams: Record<string, number[]>; indices: number[] } {
  const kinds = Object.keys(streams)
  const out: Record<string, number[]> = {}
  for (const k of kinds) out[k] = Array.from(streams[k]!.data)
  let idx = Array.from(indices)
  let count = out[kinds[0]!]!.length / streams[kinds[0]!]!.stride
  const isMember: boolean[] = []
  for (let i = 0; i < count; i++) isMember.push(member(i))
  for (let p = 0; p < passes; p++) {
    const mid = new Map<string, number>()
    const midOf = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`
      let m = mid.get(key)
      if (m !== undefined) return m
      m = count++
      for (const k of kinds) {
        const s = streams[k]!.stride
        const d = out[k]!
        for (let c = 0; c < s; c++) d.push(integer(k) ? d[a * s + c]! : (d[a * s + c]! + d[b * s + c]!) / 2)
      }
      isMember.push(true)
      mid.set(key, m)
      return m
    }
    const next: number[] = []
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!
      if (!(isMember[a] && isMember[b] && isMember[c])) {
        next.push(a, b, c)
        continue
      }
      const ab = midOf(a, b), bc = midOf(b, c), ca = midOf(c, a)
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca)
    }
    idx = next
  }
  return { streams: out, indices: idx }
}
