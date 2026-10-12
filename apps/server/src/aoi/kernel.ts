/**
 * The interest pass's per-viewer work as a pure function of a snapshot (docs/SERVER_ARCHITECTURE.md §3.5, phase P1b,
 * AOI_JOBS): the crowd pick (World.pickCrowdCells), the spawns (World.interestPassFast's reveal loop) and the despawns
 * (its refreshViewer half), with the very same conditions, arithmetic and order, over typed arrays instead of entities.
 * Worker threads (aoi/worker.ts) and the tick thread run it on slices of the viewers; the tick thread applies the
 * results in viewer order (World.interestPassJobs), so every spawn and despawn goes out as the in-thread pass sends it.
 *
 * This file runs in worker threads under Node's own TypeScript type stripping: erasable syntax only (no enums, no
 * parameter properties), and no imports but types.
 */

/** Entity flags (eflags). */
export const EF_PLAYER = 1
export const EF_MOB = 2
export const EF_COS = 4
/** Hidden from non-staff (canSee): an invisible player, a horse whose owner is an invisible player. */
export const EF_HIDDEN = 8
/** A mob with a veil (Play the Boss, Stalk): shown within `eveil` m only, except to staff and its pilot. */
export const EF_VEIL = 16

/** Viewer flags (pMeta). */
export const PM_STAFF = 1
/** Re-pick the crowd this pass (World: crowd undefined, or the staggered re-pick pass). */
export const PM_REPICK = 2
/** No re-pick and `crowd` is null (no cap in force); without PM_REPICK and PM_NULL the crowd list is in force. */
export const PM_NULL = 4

/** Result record modes (one per viewer): crowd unchanged, crowd null, crowd = the ids that follow. */
export const CROWD_KEEP = 0
export const CROWD_NONE = 1
export const CROWD_SET = 2

export interface AoiParams {
  now: number
  view: number
  hyst: number
  maxVisible: number
  swapM: number
  swaps: number
  foeMs: number
  /** Must-see keys per player (alsoMustSeeKeys: party, guild), 0 = none. */
  nKeys: number
  /** Entities (allEntities order) and players (the first P entities, world.players order). */
  E: number
  P: number
  cell: number
}

/** Offsets of the snapshot's sections in the Int32 (`I`) and Float64 (`F`) arrays. */
export interface AoiLayout {
  eid: number
  eflags: number
  epilot: number
  eowner: number
  pAnchor: number
  pTarget: number
  pMeta: number
  pKeys: number
  pKnownOff: number
  pKnownLen: number
  pCrowdOff: number
  pCrowdLen: number
  pFoeOff: number
  pFoeLen: number
  known: number
  crowd: number
  foeIds: number
  /** Int32 length in use. */
  iLen: number
  ex: number
  ez: number
  eveil: number
  foeT: number
  fLen: number
}

export function layout(E: number, P: number, K: number, nKnown: number, nCrowd: number, nFoes: number): AoiLayout {
  let i = 0
  const at = (n: number) => {
    const o = i
    i += n
    return o
  }
  const eid = at(E)
  const eflags = at(E)
  const epilot = at(E)
  const eowner = at(E)
  const pAnchor = at(P)
  const pTarget = at(P)
  const pMeta = at(P)
  const pKeys = at(P * K)
  const pKnownOff = at(P)
  const pKnownLen = at(P)
  const pCrowdOff = at(P)
  const pCrowdLen = at(P)
  const pFoeOff = at(P)
  const pFoeLen = at(P)
  const known = at(nKnown)
  const crowd = at(nCrowd)
  const foeIds = at(nFoes)
  const iLen = i
  i = 0
  const ex = at(E)
  const ez = at(E)
  const eveil = at(E)
  const foeT = at(nFoes)
  return { eid, eflags, epilot, eowner, pAnchor, pTarget, pMeta, pKeys, pKnownOff, pKnownLen, pCrowdOff, pCrowdLen, pFoeOff, pFoeLen, known, crowd, foeIds, iLen, ex, ez, eveil, foeT, fLen: i }
}

/** A crowd-pick candidate (pickCrowdCells): its distance (shown ones CROWD_SWAP_M nearer) and its candidate order. */
export interface CrowdPick {
  id: number
  d: number
  shown: boolean
  pos: number
}

/**
 * The first `k` of `list` (in candidate order) sorted by distance, as the stable `list.slice().sort(by d).slice(0, k)`
 * gives them (equal distances keep their order), without sorting all of it when k is small.
 */
export function firstSorted(list: CrowdPick[], k: number): CrowdPick[] {
  if (k <= 0) return []
  if (k > 16 || k * 4 >= list.length) return list.slice().sort((x, y) => x.d - y.d).slice(0, k)
  const out: CrowdPick[] = []
  for (const x of list) {
    // not nearer than the k-th so far: a stable sort puts it after that one
    if (out.length === k && x.d >= out[k - 1]!.d) continue
    let j = out.length
    while (j > 0 && out[j - 1]!.d > x.d) j--
    out.splice(j, 0, x)
    if (out.length > k) out.pop()
  }
  return out
}

/** cells.ts cellKey (the same numbers). */
function cellKey(cx: number, cz: number): number {
  return (cx + 0x100000) * 0x200000 + (cz + 0x100000)
}

/** The pass's uniform grid: entity indexes per cell, in allEntities order (World.interestPassFast's grid). */
export function buildGrid(F: Float64Array, L: AoiLayout, p: AoiParams): Map<number, number[]> {
  const grid = new Map<number, number[]>()
  const cell = p.cell
  for (let i = 0; i < p.E; i++) {
    const k = cellKey(Math.floor(F[L.ex + i]! / cell), Math.floor(F[L.ez + i]! / cell))
    const c = grid.get(k)
    if (c) c.push(i)
    else grid.set(k, [i])
  }
  return grid
}

/** id -> entity index (the despawn half's World.entity lookup). */
export function buildIndex(I: Int32Array, L: AoiLayout, p: AoiParams): Map<number, number> {
  const m = new Map<number, number>()
  for (let i = 0; i < p.E; i++) m.set(I[L.eid + i]!, i)
  return m
}

/** A growable Int32 result list. */
export class IntList {
  a: Int32Array
  n = 0

  constructor(cap = 1024) {
    this.a = new Int32Array(cap)
  }

  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    this.a[this.n++] = v
  }

  /** The list as a fresh Int32Array of its length. */
  take(): Int32Array {
    return this.a.slice(0, this.n)
  }
}

/**
 * Viewers [from, to): per viewer one record in `out`: crowd mode (+ count + ids), spawn count + entity indexes, despawn
 * count + ids. `grid`/`index` as buildGrid/buildIndex give them (built once per snapshot and thread).
 */
export function runSlice(I: Int32Array, F: Float64Array, L: AoiLayout, p: AoiParams, grid: Map<number, number[]>, index: Map<number, number>, from: number, to: number, out: IntList): void {
  const K = p.nKeys
  const now = p.now
  const view = p.view
  const cell = p.cell
  const cells: number[][] = []
  const spawned: number[] = []

  for (let v = from; v < to; v++) {
    const vid = I[L.eid + v]!
    const meta = I[L.pMeta + v]!
    const staff = (meta & PM_STAFF) !== 0
    const a = I[L.pAnchor + v]!
    const ax = F[L.ex + a]!
    const az = F[L.ez + a]!
    const vTarget = I[L.pTarget + v]!
    // the viewer's must-see inputs
    const kOff = L.pKeys + v * K
    let anyKey = false
    for (let k = 0; k < K; k++) if (I[kOff + k] !== 0) anyKey = true
    const foeN = I[L.pFoeLen + v]!
    let foes: Map<number, number> | null = null
    if (foeN > 0) {
      foes = new Map()
      const fo = I[L.pFoeOff + v]!
      for (let k = 0; k < foeN; k++) foes.set(I[L.foeIds + fo + k]!, F[L.foeT + fo + k]!)
    }
    const mustSee = (o: number): boolean => {
      const oid = I[L.eid + o]!
      if (vTarget !== 0 && vTarget === oid) return true
      if (I[L.pTarget + o] === vid) return true
      if (foes !== null) {
        const t = foes.get(oid)
        if (t !== undefined && now - t < p.foeMs) return true
      }
      if (!anyKey) return false
      const oOff = L.pKeys + o * K
      for (let k = 0; k < K; k++) {
        const kv = I[kOff + k]!
        if (kv !== 0 && kv === I[oOff + k]) return true
      }
      return false
    }
    const canSee = (e: number): boolean => (I[L.eflags + e]! & EF_HIDDEN) === 0 || staff || vid === I[L.eowner + e]
    const known = new Set<number>()
    const kOff2 = I[L.pKnownOff + v]!
    const kLen = I[L.pKnownLen + v]!
    for (let k = 0; k < kLen; k++) known.add(I[L.known + kOff2 + k]!)

    // the anchor's 3 x 3 cells, in the pass's order
    const cx = Math.floor(ax / cell)
    const cz = Math.floor(az / cell)
    cells.length = 0
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const c = grid.get(cellKey(cx + i, cz + j))
        if (c) cells.push(c)
      }
    }

    // ---- the crowd (pickCrowdCells, or the one in force) ----
    let crowd: Set<number> | null = null
    if ((meta & PM_REPICK) !== 0) {
      crowd = pickCrowd(I, F, L, p, cells, v, vid, ax, az, known, canSee, mustSee)
      if (crowd === null) out.push(CROWD_NONE)
      else {
        out.push(CROWD_SET)
        out.push(crowd.size)
        for (const id of crowd) out.push(id)
      }
    } else {
      out.push(CROWD_KEEP)
      if ((meta & PM_NULL) === 0) {
        crowd = new Set()
        const co = I[L.pCrowdOff + v]!
        const cn = I[L.pCrowdLen + v]!
        for (let k = 0; k < cn; k++) crowd.add(I[L.crowd + co + k]!)
      }
    }

    // ---- spawns: reveal() over the cells, the crowd cap first ----
    spawned.length = 0
    for (const c of cells) {
      for (let q = 0; q < c.length; q++) {
        const e = c[q]!
        const id = I[L.eid + e]!
        if (id === vid) continue
        const fl = I[L.eflags + e]!
        if (crowd !== null && (fl & EF_PLAYER) !== 0 && !crowd.has(id) && !mustSee(e)) continue
        if (known.has(id) || !canSee(e)) continue
        let r = view
        if ((fl & EF_VEIL) !== 0 && !staff && I[L.epilot + e] !== vid) r = Math.min(r, F[L.eveil + e]!)
        const dx = ax - F[L.ex + e]!
        const dz = az - F[L.ez + e]!
        if (!(dx * dx + dz * dz <= r * r)) continue
        known.add(id)
        spawned.push(e)
      }
    }
    out.push(spawned.length)
    for (const e of spawned) out.push(e)

    // ---- despawns: gone, invisible, out of range (with hysteresis) or crowded out; the known set's order ----
    const goneAt = out.n
    out.push(0)
    let gone = 0
    const rOut = view + p.hyst
    const check = (id: number): void => {
      const e = index.get(id)
      if (e === undefined || !canSee(e)) {
        out.push(id)
        gone++
        return
      }
      const fl = I[L.eflags + e]!
      let r = rOut
      if ((fl & EF_VEIL) !== 0 && !staff && I[L.epilot + e] !== vid) r = Math.min(r, F[L.eveil + e]!)
      const dx = ax - F[L.ex + e]!
      const dz = az - F[L.ez + e]!
      if (!(dx * dx + dz * dz <= r * r) || ((fl & EF_PLAYER) !== 0 && crowd !== null && !crowd.has(id) && !mustSee(e))) {
        out.push(id)
        gone++
      }
    }
    for (let k = 0; k < kLen; k++) check(I[L.known + kOff2 + k]!)
    for (const e of spawned) check(I[L.eid + e]!)
    out.a[goneAt] = gone
  }
}

/** World.pickCrowdCells over the snapshot: null while the cap is not needed, else the crowd (must-see ones first). */
function pickCrowd(
  I: Int32Array,
  F: Float64Array,
  L: AoiLayout,
  p: AoiParams,
  cells: number[][],
  v: number,
  vid: number,
  ax: number,
  az: number,
  known: Set<number>,
  canSee: (e: number) => boolean,
  mustSee: (o: number) => boolean,
): Set<number> | null {
  void v
  const max = p.maxVisible
  if (max <= 0) return null
  const r = p.view + p.hyst
  const shownAll: CrowdPick[] = []
  const freshAll: CrowdPick[] = []
  let n = 0
  const keep = new Set<number>()
  for (const c of cells) {
    for (let q = 0; q < c.length; q++) {
      const e = c[q]!
      const id = I[L.eid + e]!
      if ((I[L.eflags + e]! & EF_PLAYER) === 0 || id === vid) continue
      if (!canSee(e)) continue
      const d = Math.hypot(ax - F[L.ex + e]!, az - F[L.ez + e]!)
      if (d > r) continue
      if (mustSee(e)) keep.add(id)
      else if (known.has(id)) shownAll.push({ id, d: d - p.swapM, shown: true, pos: n++ })
      else freshAll.push({ id, d, shown: false, pos: n++ })
    }
  }
  if (keep.size + n <= max) return null
  const slots = Math.max(0, max - keep.size)
  const take = shownAll.length <= slots ? shownAll : firstSorted(shownAll, slots)
  const fresh = firstSorted(freshAll, slots - take.length + p.swaps)
  let f = 0
  while (take.length < slots && f < fresh.length) take.push(fresh[f++]!)
  for (let swaps = 0; swaps < p.swaps && f < fresh.length; swaps++) {
    // the farthest shown player taken; of equals the first in pickCrowd's stable order (the earliest candidate)
    let worst = -1
    for (let i = 0; i < take.length; i++) {
      const x = take[i]!
      if (x.shown && (worst < 0 || x.d > take[worst]!.d || (x.d === take[worst]!.d && x.pos < take[worst]!.pos))) worst = i
    }
    if (worst < 0 || fresh[f]!.d >= take[worst]!.d) break
    take[worst] = fresh[f++]!
  }
  for (const x of take) keep.add(x.id)
  return keep
}
