/**
 * The effect region of a weapon from its actual geometry (docs/RARITY.md §5.9): the rare effects (blade shell,
 * emitters, orbiting stars, swing ribbon, lance origin) sit on the part of the model that is the blade or head, not on
 * a per-kind guess or the dummies' line (a glaive's ai_start/ai_end run beside its blade; a spear's box includes its
 * tassel). Pure (no Babylon): the client computes it once per model in the item root's space, the converter test
 * checks it on every weapon glb.
 *
 * Method: the long axis (ai_start → ai_end when the sidecar has them, else the longest box axis); every vertex
 * projected on it and binned (REGION_BINS) along the model's full length; per bin the extent across (on the widest
 * perpendicular axis) and its centre on both perpendicular axes. A sword or blade keeps the bins from ai_start (the
 * guard) to the tip; a spear or glaive keeps the head: the bins from the tip back while they are clearly wider than
 * the shaft; a bow keeps its whole length. The region's base and tip lie on the bins' centre line.
 */

export type RegionKind = 'blade' | 'head' | 'whole'
export const REGION_BINS = 24

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface WeaponRegion {
  /** Region base and tip (on the blade's centre line), its across axis (unit) and normal (unit). */
  base: Vec3
  tip: Vec3
  across: Vec3
  normal: Vec3
  /** Half the blade's width across and half its thickness (m, the region's median). */
  halfWidth: number
  halfDepth: number
  /** The whole model along the axis, in region units (0 base, 1 tip): a shaft runs below 0. */
  span: [number, number]
  /** The far end of the model below the region (a pole's butt) on the model's own centre line, for shaft effects. */
  butt: Vec3
  /** The region's box (the union of its vertices), for checks. */
  min: Vec3
  max: Vec3
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const sub = (a: Vec3, b: Vec3) => v(a.x - b.x, a.y - b.y, a.z - b.z)
const add = (a: Vec3, b: Vec3) => v(a.x + b.x, a.y + b.y, a.z + b.z)
const scale = (a: Vec3, k: number) => v(a.x * k, a.y * k, a.z * k)
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z)
const norm = (a: Vec3) => {
  const l = len(a) || 1
  return scale(a, 1 / l)
}
const cross = (a: Vec3, b: Vec3) => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
const median = (a: number[]) => {
  if (!a.length) return 0
  const s = [...a].sort((p, q) => p - q)
  return s[Math.floor(s.length / 2)]!
}

/**
 * `pos`: the model's vertex positions (xyz, in the item root's space); `start`/`end`: ai_start/ai_end there (null: the
 * longest box axis). `kind`: what part is the effect region.
 */
export function weaponRegion(pos: ArrayLike<number>, start: Vec3 | null, end: Vec3 | null, kind: RegionKind): WeaponRegion | null {
  const n = Math.floor(pos.length / 3)
  if (n < 3) return null
  const P = (i: number) => v(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!)
  let axis: Vec3
  let origin: Vec3
  if (start && end && len(sub(end, start)) > 0.05) {
    axis = norm(sub(end, start))
    origin = start
  } else {
    let lo = v(Infinity, Infinity, Infinity)
    let hi = v(-Infinity, -Infinity, -Infinity)
    for (let i = 0; i < n; i++) {
      const p = P(i)
      lo = v(Math.min(lo.x, p.x), Math.min(lo.y, p.y), Math.min(lo.z, p.z))
      hi = v(Math.max(hi.x, p.x), Math.max(hi.y, p.y), Math.max(hi.z, p.z))
    }
    const s = sub(hi, lo)
    axis = s.x >= s.y && s.x >= s.z ? v(1, 0, 0) : s.y >= s.z ? v(0, 1, 0) : v(0, 0, 1)
    origin = scale(add(lo, hi), 0.5)
  }
  // the two perpendicular axes: the widest extent is "across"
  const cand = [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1)].map(a => sub(a, scale(axis, dot(a, axis)))).filter(a => len(a) > 0.2).map(norm)
  let across = cand[0] ?? v(0, 1, 0)
  let best = -1
  for (const c of cand) {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < n; i++) {
      const d = dot(sub(P(i), origin), c)
      lo = Math.min(lo, d)
      hi = Math.max(hi, d)
    }
    if (hi - lo > best) {
      best = hi - lo
      across = c
    }
  }
  // re-orthogonalise
  across = norm(sub(across, scale(axis, dot(across, axis))))
  const normal = norm(cross(axis, across))

  let tMin = Infinity
  let tMax = -Infinity
  const ts = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    ts[i] = dot(sub(P(i), origin), axis)
    tMin = Math.min(tMin, ts[i]!)
    tMax = Math.max(tMax, ts[i]!)
  }
  const L = tMax - tMin
  if (!(L > 1e-4)) return null
  const B = REGION_BINS
  const aLo = new Array<number>(B).fill(Infinity)
  const aHi = new Array<number>(B).fill(-Infinity)
  const nLo = new Array<number>(B).fill(Infinity)
  const nHi = new Array<number>(B).fill(-Infinity)
  const binOf = (t: number) => Math.min(B - 1, Math.max(0, Math.floor(((t - tMin) / L) * B)))
  for (let i = 0; i < n; i++) {
    const b = binOf(ts[i]!)
    const d = sub(P(i), origin)
    const a = dot(d, across)
    const m = dot(d, normal)
    aLo[b] = Math.min(aLo[b]!, a)
    aHi[b] = Math.max(aHi[b]!, a)
    nLo[b] = Math.min(nLo[b]!, m)
    nHi[b] = Math.max(nHi[b]!, m)
  }
  const width = (b: number) => (aHi[b]! > aLo[b]! ? aHi[b]! - aLo[b]! : 0)
  const has = (b: number) => aHi[b]! >= aLo[b]!

  // which end is the tip: the end ai_end lies at (else +axis)
  const tipHigh = end && start ? dot(sub(end, origin), axis) >= dot(sub(start, origin), axis) : true
  const fromTip = (k: number) => (tipHigh ? B - 1 - k : k)
  let b0: number
  let b1: number
  if (kind === 'whole') {
    b0 = 0
    b1 = B - 1
  } else if (kind === 'blade') {
    // from ai_start (the guard) to the tip
    const s = start ? binOf(dot(sub(start, origin), axis)) : 0
    b0 = tipHigh ? s : 0
    b1 = tipHigh ? B - 1 : s
  } else {
    // the head: from the tip back while clearly wider than the shaft (the narrow lower half's median width)
    const shaft: number[] = []
    for (let k = Math.floor(B / 2); k < B; k++) if (has(fromTip(k))) shaft.push(width(fromTip(k)))
    const sw = Math.max(median(shaft), L * 0.006)
    let k = 0
    while (k < B && !has(fromTip(k))) k++
    let last = k
    let gaps = 0
    for (; k < B * 0.75; k++) {
      const b = fromTip(k)
      if (has(b) && width(b) > sw * 1.6) {
        last = k
        gaps = 0
      } else if (++gaps > 1) break
    }
    // at least a sixth of the length (a slim head still gets its tip region)
    last = Math.max(last, Math.ceil(B / 6))
    b0 = Math.min(fromTip(0), fromTip(last))
    b1 = Math.max(fromTip(0), fromTip(last))
  }
  const ws: number[] = []
  const ds: number[] = []
  let ca = 0
  let cn = 0
  let cw = 0
  for (let b = b0; b <= b1; b++) {
    if (!has(b)) continue
    ws.push(width(b))
    ds.push(nHi[b]! - nLo[b]!)
    const w = width(b) + 1e-4
    ca += ((aLo[b]! + aHi[b]!) / 2) * w
    cn += ((nLo[b]! + nHi[b]!) / 2) * w
    cw += w
  }
  ca /= cw || 1
  cn /= cw || 1
  const t0 = tMin + (b0 / B) * L
  const t1 = tMin + ((b1 + 1) / B) * L
  const off = add(scale(across, ca), scale(normal, cn))
  const base = add(add(origin, scale(axis, tipHigh ? t0 : t1)), off)
  const tip = add(add(origin, scale(axis, tipHigh ? t1 : t0)), off)
  const rl = Math.abs(t1 - t0)
  const toU = (t: number) => (tipHigh ? (t - t0) / rl : (t1 - t) / rl)
  const span: [number, number] = [Math.min(toU(tMin), toU(tMax)), Math.max(toU(tMin), toU(tMax))]
  let mn = v(Infinity, Infinity, Infinity)
  let mx = v(-Infinity, -Infinity, -Infinity)
  for (let i = 0; i < n; i++) {
    const b = binOf(ts[i]!)
    if (b < b0 || b > b1) continue
    const p = P(i)
    mn = v(Math.min(mn.x, p.x), Math.min(mn.y, p.y), Math.min(mn.z, p.z))
    mx = v(Math.max(mx.x, p.x), Math.max(mx.y, p.y), Math.max(mx.z, p.z))
  }
  // the butt: the centre of the bin at the far end from the tip (the shaft's own line, not the head's axis)
  const bb = tipHigh ? 0 : B - 1
  let k2 = 0
  while (k2 < B && !has(tipHigh ? bb + k2 : bb - k2)) k2++
  const be = tipHigh ? bb + k2 : bb - k2
  const butt = has(be)
    ? add(add(origin, scale(axis, tipHigh ? tMin : tMax)), add(scale(across, (aLo[be]! + aHi[be]!) / 2), scale(normal, (nLo[be]! + nHi[be]!) / 2)))
    : add(origin, scale(axis, tipHigh ? tMin : tMax))
  return { butt, base, tip, across, normal, halfWidth: Math.max(0.006, median(ws) / 2), halfDepth: Math.max(0.003, median(ds) / 2), span, min: mn, max: mx }
}

/** Which part of a weapon kind is its effect region. */
export function regionKindOf(kind: string): RegionKind {
  return kind === 'spear' || kind === 'glaive' ? 'head' : kind === 'bow' || kind === 'shield' ? 'whole' : 'blade'
}
