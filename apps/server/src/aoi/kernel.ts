/**
 * The interest pass's per-viewer work as a pure function of a snapshot (docs/SERVER_ARCHITECTURE.md §3.5, phase P1b,
 * AOI_JOBS): the crowd pick (World.pickCrowdCells), the spawns (World.interestPassFast's reveal loop) and the despawns
 * (its refreshViewer half), with the very same conditions, arithmetic and order, over typed arrays instead of entities.
 * Worker threads (aoi/worker.ts) and the tick thread run it on slices of the viewers; the tick thread applies the
 * results in viewer order (World.interestPassJobs), so every spawn and despawn goes out as the in-thread pass sends it.
 *
 * The snapshot names entities by their index in the pass (allEntities order; players first, in world.players order) and
 * carries the pass's grid, so a thread builds nothing per entity: set lookups become stamped marks (one Int32Array per
 * thread), and World.mustSee becomes one mark per viewer (its target, who targets it, recent foes, its party and guild).
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
  /** Grid cells in use and the cell size (m). */
  C: number
  cell: number
}

/**
 * Offsets of the snapshot's sections in the Int32 (`I`) and Float64 (`F`) arrays. Lists per viewer are (offset, length)
 * into a shared section; entity references are indexes (-1: the entity is gone).
 */
export interface AoiLayout {
  eid: number
  eflags: number
  epilot: number
  eowner: number
  pAnchor: number
  /** The viewer's attack/skill target's id (0: none) and its index when it is a player (-1 otherwise). */
  pTarget: number
  pTargetIdx: number
  pMeta: number
  pKeys: number
  pKnownOff: number
  pKnownLen: number
  pCrowdOff: number
  pCrowdLen: number
  pFoeOff: number
  pFoeLen: number
  /** Known ids and their indexes, in the known set's order. */
  knownId: number
  knownIdx: number
  /** The crowd in force (no re-pick): player indexes. */
  crowdIdx: number
  /** Foes: player indexes (-1: offline). */
  foeIdx: number
  /** The grid: per cell the start and length of its run in cellEnts (entity indexes, allEntities order). */
  cellStart: number
  cellLen: number
  cellEnts: number
  /** Int32 length in use. */
  iLen: number
  ex: number
  ez: number
  eveil: number
  foeT: number
  cellKey: number
  fLen: number
}

export function layout(E: number, P: number, K: number, C: number, nKnown: number, nCrowd: number, nFoes: number): AoiLayout {
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
  const pTargetIdx = at(P)
  const pMeta = at(P)
  const pKeys = at(P * K)
  const pKnownOff = at(P)
  const pKnownLen = at(P)
  const pCrowdOff = at(P)
  const pCrowdLen = at(P)
  const pFoeOff = at(P)
  const pFoeLen = at(P)
  const knownId = at(nKnown)
  const knownIdx = at(nKnown)
  const crowdIdx = at(nCrowd)
  const foeIdx = at(nFoes)
  const cellStart = at(C)
  const cellLen = at(C)
  const cellEnts = at(E)
  const iLen = i
  i = 0
  const ex = at(E)
  const ez = at(E)
  const eveil = at(E)
  const foeT = at(nFoes)
  const cellKey = at(C)
  return {
    eid, eflags, epilot, eowner, pAnchor, pTarget, pTargetIdx, pMeta, pKeys, pKnownOff, pKnownLen, pCrowdOff, pCrowdLen, pFoeOff, pFoeLen,
    knownId, knownIdx, crowdIdx, foeIdx, cellStart, cellLen, cellEnts, iLen, ex, ez, eveil, foeT, cellKey, fLen: i,
  }
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
export function firstSorted<T extends { d: number }>(list: T[], k: number): T[] {
  if (k <= 0) return []
  if (k > 16 || k * 4 >= list.length) return list.slice().sort((x, y) => x.d - y.d).slice(0, k)
  const out: T[] = []
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
export function aoiCellKey(cx: number, cz: number): number {
  return (cx + 0x100000) * 0x200000 + (cz + 0x100000)
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

/** What one thread derives once per snapshot: the cell lookup, who targets whom, key members; and its mark arrays. */
export interface AoiPrep {
  cells: Map<number, number>
  /** Player id -> indexes of the players whose attack/skill targets it. */
  targetedBy: Map<number, number[]>
  /** Per key slot: key -> player indexes holding it there. */
  members: Map<number, number[]>[]
  known: Int32Array
  crowd: Int32Array
  must: Int32Array
  /** Stamp base: marks equal to base + viewer + 1 belong to that viewer in this run ... */
  base: number
  /** ... and every stamp of this run is below top (the next run's base). */
  top: number
}

/** prepare() for a snapshot; `prev` (the same thread's last one) lends its mark arrays when they are big enough. */
export function prepare(I: Int32Array, F: Float64Array, L: AoiLayout, p: AoiParams, prev: AoiPrep | null): AoiPrep {
  const cells = new Map<number, number>()
  for (let c = 0; c < p.C; c++) cells.set(F[L.cellKey + c]!, c)
  const targetedBy = new Map<number, number[]>()
  for (let o = 0; o < p.P; o++) {
    const t = I[L.pTarget + o]!
    if (t === 0) continue
    const l = targetedBy.get(t)
    if (l) l.push(o)
    else targetedBy.set(t, [o])
  }
  const members: Map<number, number[]>[] = []
  for (let k = 0; k < p.nKeys; k++) {
    const m = new Map<number, number[]>()
    for (let o = 0; o < p.P; o++) {
      const key = I[L.pKeys + o * p.nKeys + k]!
      if (key === 0) continue
      const l = m.get(key)
      if (l) l.push(o)
      else m.set(key, [o])
    }
    members.push(m)
  }
  // marks: stamps grow across runs (base), so the arrays are never cleared; a new array when the world grew
  let known: Int32Array
  let crowd: Int32Array
  let must: Int32Array
  let base = 0
  if (prev && prev.known.length >= p.E && prev.top + p.P + 2 < 0x7fffffff) {
    known = prev.known
    crowd = prev.crowd
    must = prev.must
    base = prev.top
  } else {
    const n = Math.max(1024, Math.ceil(p.E * 1.25))
    known = new Int32Array(n)
    crowd = new Int32Array(n)
    must = new Int32Array(n)
  }
  return { cells, targetedBy, members, known, crowd, must, base, top: base + p.P + 1 }
}

/**
 * Viewers [from, to): per viewer one record in `out`: crowd mode (+ count + ids), spawn count + entity indexes, despawn
 * count + ids.
 */
export function runSlice(I: Int32Array, F: Float64Array, L: AoiLayout, p: AoiParams, prep: AoiPrep, from: number, to: number, out: IntList): void {
  const K = p.nKeys
  const now = p.now
  const view = p.view
  const cell = p.cell
  const knownM = prep.known
  const crowdM = prep.crowd
  const mustM = prep.must
  const runs: number[] = []
  const spawned: number[] = []
  const eid = L.eid
  const eflags = L.eflags
  const cellEnts = L.cellEnts

  for (let v = from; v < to; v++) {
    const stamp = prep.base + v + 1
    const vid = I[eid + v]!
    const meta = I[L.pMeta + v]!
    const staff = (meta & PM_STAFF) !== 0
    const a = I[L.pAnchor + v]!
    const ax = F[L.ex + a]!
    const az = F[L.ez + a]!

    // World.mustSee(v, o) for every player o, as one mark: v's target, whoever targets v, foes within FOE_MEMORY_MS,
    // and whoever shares a set key at the same slot (party, guild)
    const tIdx = I[L.pTargetIdx + v]!
    if (tIdx >= 0) mustM[tIdx] = stamp
    const by = prep.targetedBy.get(vid)
    if (by) for (const o of by) mustM[o] = stamp
    const foeN = I[L.pFoeLen + v]!
    if (foeN > 0) {
      const fo = I[L.pFoeOff + v]!
      for (let k = 0; k < foeN; k++) {
        const o = I[L.foeIdx + fo + k]!
        if (o >= 0 && now - F[L.foeT + fo + k]! < p.foeMs) mustM[o] = stamp
      }
    }
    for (let k = 0; k < K; k++) {
      const key = I[L.pKeys + v * K + k]!
      if (key === 0) continue
      const ms = prep.members[k]!.get(key)
      if (ms) for (const o of ms) mustM[o] = stamp
    }
    const canSee = (e: number): boolean => (I[eflags + e]! & EF_HIDDEN) === 0 || staff || vid === I[L.eowner + e]
    const kOff = I[L.pKnownOff + v]!
    const kLen = I[L.pKnownLen + v]!
    for (let k = 0; k < kLen; k++) {
      const e = I[L.knownIdx + kOff + k]!
      if (e >= 0) knownM[e] = stamp
    }

    // the anchor's 3 x 3 cells, in the pass's order
    const cx = Math.floor(ax / cell)
    const cz = Math.floor(az / cell)
    runs.length = 0
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const c = prep.cells.get(aoiCellKey(cx + i, cz + j))
        if (c !== undefined) runs.push(c)
      }
    }

    // ---- the crowd (pickCrowdCells, or the one in force) ----
    let capped = false
    if ((meta & PM_REPICK) !== 0) {
      const keep = pickCrowd(I, F, L, p, prep, runs, vid, ax, az, stamp, canSee)
      if (keep === null) out.push(CROWD_NONE)
      else {
        capped = true
        out.push(CROWD_SET)
        out.push(keep.length)
        for (const e of keep) {
          out.push(I[eid + e]!)
          crowdM[e] = stamp
        }
      }
    } else {
      out.push(CROWD_KEEP)
      if ((meta & PM_NULL) === 0) {
        capped = true
        const co = I[L.pCrowdOff + v]!
        const cn = I[L.pCrowdLen + v]!
        for (let k = 0; k < cn; k++) {
          const e = I[L.crowdIdx + co + k]!
          if (e >= 0) crowdM[e] = stamp
        }
      }
    }

    // ---- spawns: reveal() over the cells, the crowd cap first ----
    spawned.length = 0
    for (const c of runs) {
      const s = I[L.cellStart + c]!
      const end = s + I[L.cellLen + c]!
      for (let q = s; q < end; q++) {
        const e = I[cellEnts + q]!
        if (e === v) continue
        const fl = I[eflags + e]!
        if (capped && (fl & EF_PLAYER) !== 0 && crowdM[e] !== stamp && mustM[e] !== stamp) continue
        if (knownM[e] === stamp || !canSee(e)) continue
        let r = view
        if ((fl & EF_VEIL) !== 0 && !staff && I[L.epilot + e] !== vid) r = Math.min(r, F[L.eveil + e]!)
        const dx = ax - F[L.ex + e]!
        const dz = az - F[L.ez + e]!
        if (!(dx * dx + dz * dz <= r * r)) continue
        knownM[e] = stamp
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
    const check = (e: number, id: number): void => {
      if (e < 0 || !canSee(e)) {
        out.push(id)
        gone++
        return
      }
      const fl = I[eflags + e]!
      let r = rOut
      if ((fl & EF_VEIL) !== 0 && !staff && I[L.epilot + e] !== vid) r = Math.min(r, F[L.eveil + e]!)
      const dx = ax - F[L.ex + e]!
      const dz = az - F[L.ez + e]!
      if (!(dx * dx + dz * dz <= r * r) || (capped && (fl & EF_PLAYER) !== 0 && crowdM[e] !== stamp && mustM[e] !== stamp)) {
        out.push(id)
        gone++
      }
    }
    for (let k = 0; k < kLen; k++) check(I[L.knownIdx + kOff + k]!, I[L.knownId + kOff + k]!)
    for (const e of spawned) check(e, I[eid + e]!)
    out.a[goneAt] = gone
  }
}

/** A crowd candidate here: CrowdPick with the entity index. */
interface Pick {
  e: number
  d: number
  shown: boolean
  pos: number
}

/**
 * World.pickCrowdCells over the snapshot: null while the cap is not needed, else the crowd as entity indexes in the
 * order World builds its Set (must-see ones first, in candidate order, then the taken ones).
 */
function pickCrowd(
  I: Int32Array,
  F: Float64Array,
  L: AoiLayout,
  p: AoiParams,
  prep: AoiPrep,
  runs: number[],
  vid: number,
  ax: number,
  az: number,
  stamp: number,
  canSee: (e: number) => boolean,
): number[] | null {
  const max = p.maxVisible
  if (max <= 0) return null
  const r = p.view + p.hyst
  const shownAll: Pick[] = []
  const freshAll: Pick[] = []
  let n = 0
  const keep: number[] = []
  for (const c of runs) {
    const s = I[L.cellStart + c]!
    const end = s + I[L.cellLen + c]!
    for (let q = s; q < end; q++) {
      const e = I[L.cellEnts + q]!
      if ((I[L.eflags + e]! & EF_PLAYER) === 0 || I[L.eid + e] === vid) continue
      if (!canSee(e)) continue
      const d = Math.hypot(ax - F[L.ex + e]!, az - F[L.ez + e]!)
      if (d > r) continue
      if (prep.must[e] === stamp) keep.push(e)
      else if (prep.known[e] === stamp) shownAll.push({ e, d: d - p.swapM, shown: true, pos: n++ })
      else freshAll.push({ e, d, shown: false, pos: n++ })
    }
  }
  if (keep.length + n <= max) return null
  const slots = Math.max(0, max - keep.length)
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
  for (const x of take) keep.push(x.e)
  return keep
}
