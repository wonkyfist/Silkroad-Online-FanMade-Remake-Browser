#!/usr/bin/env node
// Licensed characters, the body slices (docs/CHARACTERS.md §16.9): the pack's body comes in slices (BODY_PART_01..08)
// so the game can hide the skin under the worn pieces. A whole slice was hidden once the pieces covered enough of its
// vertices (0.7 for the legs under loose pants): the calves and ankles between short loose pants and short boots went
// with it and the boots floated. And the lower LODs simplified every slice on its own, so their borders no longer met
// (cracks, light seams at the cuts). This step, on the converter's glTF (licensed-char.ts calls it; the CLI patches
// built files in place):
// 1. seams: at LOD0 the slices' coincident border vertices get one normal and one skin (the pack's neck border
//    differs by up to 3 % weight: a dotted crack once skinned); at LOD1 / LOD2 every border vertex of a slice (and of
//    the head) near a LOD0 seam moves onto that seam, with its normal and skin, so both sides of a cut meet again.
// 2. coverage per vertex: which pieces (of the same LOD) cover it. A ray out along the normal hits the piece within
//    15 cm, or leaves through the piece's inside within 35 cm (loose pants hang far off the seat), or the piece is
//    within 6 mm.
// 3. sub-slices: a triangle is hidden by a worn set when all three of its vertices are covered. Every slice is cut
//    into the groups of triangles that the same wearable sets hide (wearablePieceSets: every slot empty or of each
//    class), `BODY_PART_04_S2` and so on at every LOD; the sidecar's coverage rows are per sub-slice and
//    `exact: true` tells the game to hide one only when it is covered entirely (licensed-outfit.ts hiddenSlices).
//   pnpm tsx packages/convert/src/tools/licensed/body-slices.ts [--dir work/out/char/licensed/waterbender] [--only f_01,m_01]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeIO, type Document, type Node, type Primitive } from '@gltf-transform/core'
import { SLICE_KEEP, partKeyOf, sliceBase, wearablePieceSets } from '../../../../../apps/game/src/three/licensed-outfit.ts'

/** A ray along the normal that hits a piece within this covers the vertex (the Blender export's test). */
export const RAY_NEAR_M = 0.15
/** ... or one that leaves through the piece's inside (its face turned away) within this (loose cloth). */
export const RAY_FAR_M = 0.35
/** ... or a piece this close. */
export const NEAR_M = 0.006
/** A lower LOD's border vertex this close to a LOD0 seam moves onto it. */
export const SNAP_M = 0.03
/** The largest hole in a piece's coverage closed (fillHoles), in vertices. */
export const HOLE_MAX = 40
/** A slice is cut into at most this many sub-slices (each a mesh at every LOD). */
export const MAX_CUTS = 8

type V3 = [number, number, number]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

// ---- a triangle BVH (ray: nearest hit; point: any triangle within r) ----------------------------------------------

interface BvhNode {
  min: V3
  max: V3
  l?: BvhNode
  r?: BvhNode
  tris?: number[]
}
export class TriBvh {
  readonly root: BvhNode | null
  constructor(readonly tri: Float64Array) {
    const n = tri.length / 9
    const ids = Array.from({ length: n }, (_, i) => i)
    this.root = n ? this.build(ids) : null
  }
  private c(i: number, k: number) {
    const t = this.tri
    return (t[i * 9 + k]! + t[i * 9 + 3 + k]! + t[i * 9 + 6 + k]!) / 3
  }
  private build(ids: number[]): BvhNode {
    const min: V3 = [Infinity, Infinity, Infinity]
    const max: V3 = [-Infinity, -Infinity, -Infinity]
    for (const i of ids) for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) {
      const x = this.tri[i * 9 + v * 3 + k]!
      if (x < min[k]!) min[k] = x
      if (x > max[k]!) max[k] = x
    }
    if (ids.length <= 6) return { min, max, tris: ids }
    const ext = sub(max, min)
    const ax = ext[0] > ext[1] && ext[0] > ext[2] ? 0 : ext[1] > ext[2] ? 1 : 2
    ids.sort((a, b) => this.c(a, ax) - this.c(b, ax))
    const h = ids.length >> 1
    return { min, max, l: this.build(ids.slice(0, h)), r: this.build(ids.slice(h)) }
  }
  private triOf(i: number): [V3, V3, V3] {
    const t = this.tri, o = i * 9
    return [[t[o]!, t[o + 1]!, t[o + 2]!], [t[o + 3]!, t[o + 4]!, t[o + 5]!], [t[o + 6]!, t[o + 7]!, t[o + 8]!]]
  }
  /** The nearest hit along the ray within `far`: its distance and the triangle's geometric normal. */
  ray(o: V3, d: V3, far: number): { t: number; n: V3 } | null {
    let best: { t: number; n: V3 } | null = null
    const inv: V3 = [1 / d[0], 1 / d[1], 1 / d[2]]
    const stack: BvhNode[] = this.root ? [this.root] : []
    while (stack.length) {
      const nd = stack.pop()!
      let t0 = 0, t1 = best ? best.t : far
      let miss = false
      for (let k = 0; k < 3 && !miss; k++) {
        let a = (nd.min[k]! - o[k]!) * inv[k]!, b = (nd.max[k]! - o[k]!) * inv[k]!
        if (a > b) [a, b] = [b, a]
        t0 = Math.max(t0, a)
        t1 = Math.min(t1, b)
        if (t0 > t1) miss = true
      }
      if (miss) continue
      if (nd.tris) {
        for (const i of nd.tris) {
          const [a, b, c] = this.triOf(i)
          const e1 = sub(b, a), e2 = sub(c, a)
          const p = cross(d, e2)
          const det = dot(e1, p)
          if (Math.abs(det) < 1e-12) continue
          const s = sub(o, a)
          const u = dot(s, p) / det
          if (u < 0 || u > 1) continue
          const q = cross(s, e1)
          const v = dot(d, q) / det
          if (v < 0 || u + v > 1) continue
          const t = dot(e2, q) / det
          if (t > 0 && t < (best ? best.t : far)) best = { t, n: norm(cross(e1, e2)) }
        }
      } else stack.push(nd.l!, nd.r!)
    }
    return best
  }
  /** Whether a triangle lies within `r` of `p`. */
  near(p: V3, r: number): boolean {
    const stack: BvhNode[] = this.root ? [this.root] : []
    while (stack.length) {
      const nd = stack.pop()!
      let d2 = 0
      for (let k = 0; k < 3; k++) {
        const e = p[k]! < nd.min[k]! ? nd.min[k]! - p[k]! : p[k]! > nd.max[k]! ? p[k]! - nd.max[k]! : 0
        d2 += e * e
      }
      if (d2 > r * r) continue
      if (!nd.tris) {
        stack.push(nd.l!, nd.r!)
        continue
      }
      for (const i of nd.tris) {
        const [a, b, c] = this.triOf(i)
        const q = closestOnTri(p, a, b, c)
        const e = sub(p, q)
        if (dot(e, e) <= r * r) return true
      }
    }
    return false
  }
}

/** The closest point of triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTri(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a)
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]
  }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]
  }
  const den = 1 / (va + vb + vc)
  const v = vb * den, w = vc * den
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}

/** The closest point of segment ab to p and its parameter. */
function closestOnSeg(p: V3, a: V3, b: V3): { q: V3; t: number } {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0
  return { q: [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t], t }
}

// ---- the glTF side ------------------------------------------------------------------------------------------------

/** One primitive of a part, its vertices in the scene's space. */
interface Part {
  node: Node
  prim: Primitive
  key: string
  lod: number
  pos: V3[]
  nrm: V3[]
  idx: number[]
}

function partsOf(doc: Document): Part[] {
  const out: Part[] = []
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const name = node.getName()
    const lod = Number(/__LOD(\d)$/.exec(name)?.[1] ?? 0)
    const key = partKeyOf(name)
    // the head joins the seams (the neck's border); at the lower LODs it is a primitive of the joined object
    for (const prim of mesh.listPrimitives()) {
      const k = key ?? (prim.getMaterial()?.getName() === 'MAT_HEAD' && /_HEAD$|^SK_WATERBENDER__LOD\d$/.test(name) ? 'HEAD' : null)
      if (!k) continue
      const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), I = prim.getIndices()
      if (!P || !N || !I) continue
      const m = node.getWorldMatrix()
      const pos: V3[] = [], nrm: V3[] = []
      for (let i = 0; i < P.getCount(); i++) {
        const p = P.getElement(i, [0, 0, 0]) as V3
        const n = N.getElement(i, [0, 0, 0]) as V3
        pos.push([m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]])
        nrm.push(norm([m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]]))
      }
      out.push({ node, prim, key: k, lod, pos, nrm, idx: Array.from(I.getArray()!) })
    }
  }
  return out
}

/** The vertices on a primitive's open border (edges of one triangle). */
function borderEdges(idx: readonly number[]): [number, number][] {
  const cnt = new Map<number, [number, number, number]>()
  for (let i = 0; i < idx.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = idx[i + k]!, b = idx[i + ((k + 1) % 3)]!
    const lo = Math.min(a, b), hi = Math.max(a, b)
    const h = lo * 1048576 + hi
    const e = cnt.get(h)
    if (e) e[2]++
    else cnt.set(h, [lo, hi, 1])
  }
  return [...cnt.values()].filter(e => e[2] === 1).map(e => [e[0], e[1]])
}

const skinOf = (p: Primitive, i: number) => ({ j: p.getAttribute('JOINTS_0')?.getElement(i, []) ?? null, w: p.getAttribute('WEIGHTS_0')?.getElement(i, []) ?? null })
function setSkin(p: Primitive, i: number, s: { j: number[] | null; w: number[] | null }): void {
  if (s.j) p.getAttribute('JOINTS_0')?.setElement(i, s.j)
  if (s.w) p.getAttribute('WEIGHTS_0')?.setElement(i, s.w)
}
function setPos(part: Part, i: number, q: V3, n: V3): void {
  // the slices hang in the scene's space (the export bakes the transforms): the node is identity, written as is
  part.prim.getAttribute('POSITION')!.setElement(i, q)
  part.prim.getAttribute('NORMAL')!.setElement(i, n)
  part.pos[i] = q
  part.nrm[i] = n
}

interface SeamSeg {
  a: V3
  b: V3
  na: V3
  nb: V3
  sa: { j: number[] | null; w: number[] | null }
  sb: { j: number[] | null; w: number[] | null }
}

/** Step 1: one normal and one skin at the LOD0 seams; the lower LODs' borders onto those seams. */
export function weldSeams(parts: Part[]): { welded: number; snapped: number; worst: number } {
  const body = parts.filter(p => p.key === 'HEAD' || p.key.startsWith('BODY_PART_'))
  const q = (p: V3) => p.map(x => Math.round(x * 1e4)).join(',')
  let welded = 0
  const seams: SeamSeg[] = []
  const lod0 = body.filter(p => p.lod === 0)
  const at = new Map<string, { part: Part; i: number }[]>()
  for (const part of lod0) part.pos.forEach((p, i) => (at.get(q(p)) ?? at.set(q(p), []).get(q(p))!).push({ part, i }))
  for (const vs of at.values()) {
    if (new Set(vs.map(v => v.part)).size < 2) continue
    // one normal (their mean) and the first slice's skin (the head's last: the body decides the neck's skin)
    const n = norm(vs.reduce<V3>((s, v) => [s[0] + v.part.nrm[v.i]![0], s[1] + v.part.nrm[v.i]![1], s[2] + v.part.nrm[v.i]![2]], [0, 0, 0]))
    const src = [...vs].sort((a, b) => (a.part.key === 'HEAD' ? 1 : 0) - (b.part.key === 'HEAD' ? 1 : 0) || a.part.key.localeCompare(b.part.key))[0]!
    const s = skinOf(src.part.prim, src.i)
    for (const v of vs) {
      setPos(v.part, v.i, v.part.pos[v.i]!, n)
      setSkin(v.part.prim, v.i, s)
    }
    welded++
  }
  // the seams: LOD0 border edges whose two ends are shared with another part
  for (const part of lod0) {
    for (const [a, b] of borderEdges(part.idx)) {
      const ka = at.get(q(part.pos[a]!)), kb = at.get(q(part.pos[b]!))
      if (!ka || !kb || new Set(ka.map(v => v.part)).size < 2 || new Set(kb.map(v => v.part)).size < 2) continue
      seams.push({ a: part.pos[a]!, b: part.pos[b]!, na: part.nrm[a]!, nb: part.nrm[b]!, sa: skinOf(part.prim, a), sb: skinOf(part.prim, b) })
    }
  }
  let snapped = 0
  let worst = 0
  for (const part of body.filter(p => p.lod > 0)) {
    const seen = new Set<number>()
    for (const e of borderEdges(part.idx)) for (const i of e) {
      if (seen.has(i)) continue
      seen.add(i)
      const p = part.pos[i]!
      let best: { d: number; q: V3; t: number; s: SeamSeg } | null = null
      for (const s of seams) {
        const c = closestOnSeg(p, s.a, s.b)
        const e2 = sub(p, c.q)
        const d = Math.sqrt(dot(e2, e2))
        if (d < SNAP_M && (!best || d < best.d)) best = { d, q: c.q, t: c.t, s }
      }
      if (!best) continue
      const s = best.s
      const n = norm([s.na[0] + (s.nb[0] - s.na[0]) * best.t, s.na[1] + (s.nb[1] - s.na[1]) * best.t, s.na[2] + (s.nb[2] - s.na[2]) * best.t])
      setPos(part, i, best.q, n)
      setSkin(part.prim, i, best.t < 0.5 ? s.sa : s.sb)
      worst = Math.max(worst, best.d)
      snapped++
    }
  }
  return { welded, snapped, worst }
}

/** Step 2: per vertex of each slice, the pieces (bits in `pieces` order) of the same LOD that cover it. */
export function coverMasks(parts: Part[], pieces: readonly string[]): Map<Part, number[]> {
  const trees = new Map<string, TriBvh>()
  const byLodPiece = new Map<string, Part[]>()
  for (const p of parts) if (pieces.includes(p.key)) (byLodPiece.get(`${p.lod}|${p.key}`) ?? byLodPiece.set(`${p.lod}|${p.key}`, []).get(`${p.lod}|${p.key}`)!).push(p)
  for (const [k, ps] of byLodPiece) {
    const n = ps.reduce((s, p) => s + p.idx.length / 3, 0)
    const tri = new Float64Array(n * 9)
    let o = 0
    for (const p of ps) for (let i = 0; i < p.idx.length; i++) {
      const v = p.pos[p.idx[i]!]!
      tri[o++] = v[0]
      tri[o++] = v[1]
      tri[o++] = v[2]
    }
    trees.set(k, new TriBvh(tri))
  }
  const out = new Map<Part, number[]>()
  for (const part of parts.filter(p => p.key.startsWith('BODY_PART_'))) {
    const masks = part.pos.map((p, i) => {
      const n = part.nrm[i]!
      const o: V3 = [p[0] + n[0] * 0.001, p[1] + n[1] * 0.001, p[2] + n[2] * 0.001]
      let mask = 0
      pieces.forEach((key, b) => {
        const t = trees.get(`${part.lod}|${key}`)
        if (!t || b >= 31) return
        const hit = t.ray(o, n, RAY_FAR_M)
        if ((hit && (hit.t <= RAY_NEAR_M || dot(hit.n, n) > 0)) || t.near(p, NEAR_M)) mask |= 1 << b
      })
      return mask
    })
    fillHoles(part, masks, Math.min(31, pieces.length))
    out.set(part, masks)
  }
  return out
}

/**
 * Small holes in a piece's coverage closed: a patch of at most HOLE_MAX vertices the piece's covered vertices ring all
 * round (not touching the slice's border) is under it too. The rays miss there where loose cloth hangs far off a fold
 * (the seat, the back of the knee); shown, such a patch pokes through the cloth as soon as the legs bend.
 */
export function fillHoles(part: { idx: readonly number[]; pos: readonly unknown[] }, masks: number[], bits: number): number {
  const n = part.pos.length
  const nb: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < part.idx.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = part.idx[i + k]!, b = part.idx[i + ((k + 1) % 3)]!
    nb[a]!.push(b)
    nb[b]!.push(a)
  }
  const border = new Set(borderEdges(part.idx).flat())
  let filled = 0
  for (let b = 0; b < bits; b++) {
    const bit = 1 << b
    if (!masks.some(m => m & bit)) continue
    const seen = new Uint8Array(n)
    for (let v = 0; v < n; v++) {
      if (seen[v] || masks[v]! & bit) continue
      const comp = [v]
      seen[v] = 1
      let open = false
      for (let q = 0; q < comp.length; q++) {
        const u = comp[q]!
        if (border.has(u)) open = true
        for (const w of nb[u]!) if (!seen[w] && !(masks[w]! & bit)) {
          seen[w] = 1
          comp.push(w)
        }
      }
      if (open || comp.length > HOLE_MAX) continue
      for (const u of comp) masks[u]! |= bit
      filled += comp.length
    }
  }
  return filled
}

/** Copies the vertices `keep` of `src` into a new primitive with `idx` (renumbered). */
function subPrimitive(doc: Document, src: Primitive, tris: number[]): Primitive {
  const used = [...new Set(tris)].sort((a, b) => a - b)
  const map = new Map(used.map((v, i) => [v, i]))
  const prim = doc.createPrimitive().setMaterial(src.getMaterial()).setMode(src.getMode())
  for (const sem of src.listSemantics()) {
    const a = src.getAttribute(sem)!
    const raw = a.getArray()!
    const sz = a.getElementSize()
    const arr = new (raw.constructor as new (n: number) => typeof raw)(used.length * sz)
    used.forEach((v, i) => {
      for (let k = 0; k < sz; k++) arr[i * sz + k] = raw[v * sz + k]!
    })
    prim.setAttribute(sem, doc.createAccessor().setType(a.getType()).setArray(arr).setNormalized(a.getNormalized()).setBuffer(a.getBuffer()))
  }
  const I = used.length > 65535 ? new Uint32Array(tris.length) : new Uint16Array(tris.length)
  tris.forEach((v, i) => (I[i] = map.get(v)!))
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(I).setBuffer(src.getIndices()!.getBuffer()))
  return prim
}

export interface SliceResult {
  slices: Record<string, [number, number][]>
  /** The sub-slices per slice (1: not cut). */
  cuts: Record<string, number>
  seams: { welded: number; snapped: number; worst: number }
}

/**
 * The whole step on a licensed body's glTF (the converter's, or a built file): seams welded, slices cut by coverage.
 * Returns the sidecar's coverage rows per (sub-)slice.
 */
export function refineBodySlices(doc: Document, pieces: readonly string[], gender: 'f' | 'm'): SliceResult {
  const parts = partsOf(doc)
  if (parts.some(p => /_S\d+$/.test(p.key))) throw new Error('body-slices: the slices are cut already')
  const seams = weldSeams(parts)
  const masks = coverMasks(parts, pieces)
  const sets = wearablePieceSets(gender).map(s => s.reduce((m, k) => (pieces.indexOf(k) >= 0 && pieces.indexOf(k) < 31 ? m | (1 << pieces.indexOf(k)) : m), 0))
  // per slice: the signature of every triangle (which wearable sets hide it), numbered over every LOD (LOD0 first)
  const sigIds = new Map<string, Map<string, number>>()
  const triSig = new Map<Part, string[]>()
  for (const part of [...masks.keys()].sort((a, b) => a.lod - b.lod)) {
    const m = masks.get(part)!
    const keep = SLICE_KEEP[gender].includes(part.key)
    const sigs: string[] = []
    for (let i = 0; i < part.idx.length; i += 3) {
      const a = m[part.idx[i]!]!, b = m[part.idx[i + 1]!]!, c = m[part.idx[i + 2]!]!
      sigs.push(keep ? '' : sets.map(w => (a & w && b & w && c & w ? '1' : '0')).join(''))
    }
    triSig.set(part, sigs)
  }
  // at most MAX_CUTS sub-slices a slice: the two groups whose join loses the least hiding are joined (the joined group
  // hides only where both did: a little more skin under the cloth, never a gap)
  const bySlice = new Map<string, Map<string, number>>()
  for (const [part, sigs] of triSig) {
    const c = bySlice.get(part.key) ?? bySlice.set(part.key, new Map()).get(part.key)!
    for (const s of sigs) c.set(s, (c.get(s) ?? 0) + (part.lod === 0 ? 1 : 0.25))
  }
  const and = (a: string, b: string) => Array.from(a, (ch, i) => (ch === '1' && b[i] === '1' ? '1' : '0')).join('')
  const ones = (a: string) => a.split('1').length - 1
  for (const [key, counts] of bySlice) {
    const into = new Map<string, string>([...counts.keys()].map(s => [s, s]))
    const live = new Map(counts)
    while (live.size > MAX_CUTS) {
      // the pair whose join loses the fewest (triangle, hiding set) pairs
      let g = '', best: string | null = null, cost = Infinity
      const ks = [...live.keys()]
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
        const x = ks[i]!, y = ks[j]!, o = ones(and(x, y))
        const c = live.get(x)! * (ones(x) - o) + live.get(y)! * (ones(y) - o)
        if (c < cost) [g, best, cost] = [x, y, c]
      }
      const m = and(g, best!)
      const n = live.get(g)! + live.get(best!)!
      live.delete(g)
      live.delete(best!)
      live.set(m, (live.get(m) ?? 0) + n)
      for (const [s, t] of into) if (t === g || t === best) into.set(s, m)
    }
    const ids = new Map<string, number>()
    // numbered by size (the biggest first) for stable names
    const order = [...live].sort((a, b) => b[1] - a[1]).map(([s]) => s)
    for (const [s, t] of into) ids.set(s, order.indexOf(t) + 1)
    sigIds.set(key, ids)
  }
  const rows = new Map<string, Map<number, number>>()
  const add = (key: string, mask: number) => {
    const r = rows.get(key) ?? rows.set(key, new Map()).get(key)!
    r.set(mask, (r.get(mask) ?? 0) + 1)
  }
  const cuts: Record<string, number> = {}
  for (const [part, sigs] of triSig) {
    const ids = sigIds.get(part.key)!
    const nCuts = new Set(ids.values()).size
    cuts[part.key] = nCuts
    const m = masks.get(part)!
    if (nCuts < 2) {
      for (const v of new Set(part.idx)) add(part.key, m[v]!)
      continue
    }
    // one node per sub-slice (same skin, same parent), the slice's node and primitive out
    const groups = new Map<number, number[]>()
    sigs.forEach((s, t) => {
      const g = ids.get(s)!
      const list = groups.get(g) ?? groups.set(g, []).get(g)!
      list.push(part.idx[t * 3]!, part.idx[t * 3 + 1]!, part.idx[t * 3 + 2]!)
    })
    const name = part.node.getName()
    const lodSuffix = /__LOD\d$/.exec(name)?.[0] ?? ''
    const stem = name.slice(0, name.length - lodSuffix.length)
    const parent = part.node.getParentNode()
    const scenes = doc.getRoot().listScenes().filter(s => s.listChildren().includes(part.node))
    for (const [g, tris] of [...groups].sort((a, b) => a[0] - b[0])) {
      const key = `${part.key}_S${g}`
      for (const v of new Set(tris)) add(key, m[v]!)
      const prim = subPrimitive(doc, part.prim, tris)
      const nd = doc
        .createNode(`${stem}_S${g}${lodSuffix}`)
        .setMesh(doc.createMesh(`${stem}_S${g}${lodSuffix}`).addPrimitive(prim))
        .setSkin(part.node.getSkin())
        .setTranslation(part.node.getTranslation())
        .setRotation(part.node.getRotation())
        .setScale(part.node.getScale())
      if (parent) parent.addChild(nd)
      for (const s of scenes) s.addChild(nd)
    }
    const mesh = part.node.getMesh()!
    const olds = part.prim.listSemantics().map(s => part.prim.getAttribute(s)!).concat(part.prim.getIndices() ? [part.prim.getIndices()!] : [])
    mesh.removePrimitive(part.prim)
    part.prim.dispose()
    for (const a of olds) if (a.listParents().every(p => p === doc.getRoot())) a.dispose()
    if (!mesh.listPrimitives().length) {
      part.node.dispose()
      mesh.dispose()
    }
  }
  const slices: Record<string, [number, number][]> = {}
  for (const [k, r] of [...rows].sort((a, b) => a[0].localeCompare(b[0]))) slices[k] = [...r].sort((a, b) => b[1] - a[1])
  return { slices, cuts, seams }
}

/** The sub-slice keys a slice became (tests, the bench). */
export function subSlicesOf(slices: Record<string, unknown>, slice: string): string[] {
  return Object.keys(slices).filter(k => sliceBase(k) === slice)
}

// ---- CLI: patch built files -----------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
  const repo = resolve(new URL('../../../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const dirs = flag('--dir') ? [resolve(flag('--dir')!)] : ['work/out', 'work/out-opt'].map(d => join(repo, d, 'char/licensed/waterbender')).filter(existsSync)
  const only = new Set((flag('--only') ?? '').split(',').filter(Boolean))
  const io = new NodeIO()
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter(f => /^waterbender_[fm]_\d\d\.glb$/.test(f))) {
      const id = f.slice(12, 16)
      if (only.size && !only.has(id)) continue
      const side = JSON.parse(readFileSync(join(dir, f.replace(/\.glb$/, '.json')), 'utf8')) as { licensed?: { gender?: 'f' | 'm'; wardrobe?: { pieces: string[]; slices: unknown; exact?: boolean } } }
      const w = side.licensed?.wardrobe
      if (!w || !side.licensed?.gender) continue
      if (w.exact) {
        console.log(`${dir}/${f}: cut already`)
        continue
      }
      const doc = await io.read(join(dir, f))
      const t0 = Date.now()
      const r = refineBodySlices(doc, w.pieces, side.licensed.gender)
      w.slices = r.slices
      w.exact = true
      writeFileSync(join(dir, f), await io.writeBinary(doc))
      writeFileSync(join(dir, f.replace(/\.glb$/, '.json')), JSON.stringify(side))
      console.log(`${dir}/${f}: seams ${r.seams.welded} welded, ${r.seams.snapped} LOD border vertices snapped (≤ ${(r.seams.worst * 100).toFixed(1)} cm); cuts ${JSON.stringify(r.cuts)} (${Date.now() - t0} ms)`)
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
