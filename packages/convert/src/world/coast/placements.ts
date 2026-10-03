/**
 * C9: retail placements on ground the coast moved (docs/COAST.md §3B.5, §5.4 step 4; S-TREE / S-DRAW). Node-free.
 *
 * By placement (owner region, uid), on the pass's lattice:
 * - the origin stands in the coast's sea (water surface that is not retail water inside the bounds) on new ground
 *   below SL + dropBelowSeaM: dropped (and listed unless vegetation), however little the ground moved (W10R PL-1: a
 *   retail tree on ground already below the sea level, or with no retail ground at all, stood in the new sea);
 * - the ground under the placement's origin moved by at most `dropMovedM`: nothing;
 * - vegetation (by model path) is re-snapped by the ground's move when the new ground is at least SL + dropBelowSeaM
 *   and the owner region is exported (W10R PL-2: otherwise no exported terrain is drawn under it), and dropped
 *   otherwise;
 * - every other model is dropped and listed (for hand placement in content/coast/props.json);
 * - coast.json `placements.drop` drops a placement by hand (P-DATA, wave 10r polish: a tree whose roots hang over the
 *   lowered ring), whatever its ground did.
 * Every dropped placement's footprint (model bounds x transform, region units) goes to `dropFootprints`: the minimap
 * draws our render there instead of the retail pixels, which have the object baked in (W10R DD-1, ./minimap.ts).
 * The footprint check lists the placements that stay but whose model footprint (bounds x transform, 9 x 9 samples)
 * covers ground moved by more than dropMovedM (the tomb cliffs must never appear there, §3B.4); the ones coast.json
 * `placements.accept` lists (checked by hand: nothing floats or sinks) go to `accepted` instead.
 *
 * The edits go to ../passes.ts, which applies them before the static-variant and grass passes, so a dropped uid is
 * never seen by them (S-DRAW), and the runtime batcher builds from the edited manifest.placements only.
 */
import type { WorldModel, WorldPlacement } from '../manifest.ts'
import type { PlacementEdits } from '../passes.ts'
import type { CoastConfig } from './config.ts'
import { CELLS_PER_REGION, REGION_M } from './lattice.ts'
import type { CoastResult } from './pass.ts'

/** Model paths that count as vegetation (the census's rule, work/tmp/coast-beach/census.py). */
export const VEGETATION_KEYS: readonly string[] = ['tree', 'bush', 'grass', 'flower', 'reed', 'brush', 'plant', 'tre_']

export const isVegetation = (source: string) => {
  const s = source.toLowerCase()
  return VEGETATION_KEYS.some(k => s.includes(k))
}

/** Bilinear lattice sample at region coordinates; NaN outside the lattice or where a corner is NaN. */
export function sampleLattice(r: CoastResult, a: ArrayLike<number>, x: number, z: number): number {
  const { rows, cols, x0, z1 } = r.shape
  const fc = (x - x0) * CELLS_PER_REGION
  const fr = (z1 + 1 - z) * CELLS_PER_REGION
  const c = Math.floor(fc)
  const row = Math.floor(fr)
  if (c < 0 || row < 0 || c >= cols - 1 || row >= rows - 1) return NaN
  const tx = fc - c
  const tz = fr - row
  const k = row * cols + c
  return (a[k]! * (1 - tx) + a[k + 1]! * tx) * (1 - tz) + (a[k + cols]! * (1 - tx) + a[k + cols + 1]! * tx) * tz
}

export interface FootprintFinding {
  region: number
  uid: number
  source: string
  maxMoveM: number
}

/** A dropped placement's footprint on the map: a convex quad (region units, x east, z north). */
export interface DropFootprint {
  corners: ReadonlyArray<readonly [number, number]>
}

/** The footprint is grown by this much (m) on every side: the retail minimap's baked object is drawn a little wider. */
export const DROP_FOOTPRINT_PAD_M = 1.5
/** A model without usable bounds is drawn as a square of this half-side (m). */
const DROP_FOOTPRINT_MIN_HALF_M = 2

export interface C9Result {
  edits: PlacementEdits
  /** The footprints of the dropped placements (./minimap.ts CoastMinimapOptions.dropped). */
  dropFootprints: DropFootprint[]
  /** Dropped placements that are not vegetation (listed for hand placement), with their model. */
  listed: Array<{ region: number; uid: number; source: string; moveM: number }>
  footprints: FootprintFinding[]
  /** Footprint findings coast.json `placements.accept` lists. */
  accepted: FootprintFinding[]
  /** coast.json `placements.drop` entries that matched no placement (stale). */
  unmatched: string[]
}

/**
 * The C9 edits for `placements` (glTF metres relative to the origin region's south-west corner). `retail`: the retail
 * heights on the lattice (NaN where none).
 */
export function placementEdits(
  r: CoastResult, cfg: CoastConfig, retail: Float64Array, origin: { x: number; z: number },
  placements: readonly WorldPlacement[], models: readonly WorldModel[],
): C9Result {
  const SL = cfg.seaLevelM
  const pc = cfg.placements
  const out: C9Result = { edits: { drop: [], resnap: [], add: [] }, dropFootprints: [], listed: [], footprints: [], accepted: [], unmatched: [] }
  const key = (region: number, uid: number) => `${region}:${uid}`
  const byHand = new Set((pc.drop ?? []).map(e => key(e.region, e.uid)))
  const accept = new Set((pc.accept ?? []).map(e => key(e.region, e.uid)))
  const handDropped = new Set<string>()
  const toRegion = (gx: number, gz: number) => ({ x: origin.x + gx / REGION_M, z: origin.z - gz / REGION_M })
  const move = (x: number, z: number) => {
    const a = sampleLattice(r, r.h, x, z)
    const b = sampleLattice(r, retail, x, z)
    return { now: a, delta: a - b }
  }
  // the coast's sea at a lattice vertex: water surface, but not the retail water that keeps its own plane in the bounds
  const m0 = r.masks
  const seaV = new Float64Array(r.h.length)
  if (m0?.waterSurface) for (let i = 0; i < seaV.length; i++) seaV[i] = m0.waterSurface[i] && !(m0.inPlay[i] && m0.wetR[i]) ? 1 : 0
  const drop = (p: WorldPlacement, model: WorldModel | undefined, moveM: number) => {
    const ref = { region: p.region, uid: p.uid }
    out.edits.drop.push(ref)
    if (!isVegetation(p.source)) out.listed.push({ ...ref, source: p.source, moveM: Number.isFinite(moveM) ? Math.round(moveM * 100) / 100 : 0 })
    out.dropFootprints.push(dropFootprint(p, model, toRegion))
  }
  for (const p of placements) {
    const at = toRegion(p.position[0], p.position[2])
    const m = move(at.x, at.z)
    const model = models[p.models[0] ?? -1]
    if (byHand.has(key(p.region, p.uid))) {
      handDropped.add(key(p.region, p.uid))
      drop(p, model, m.delta)
      continue
    }
    if (Number.isFinite(m.now) && m.now < SL + pc.dropBelowSeaM && sampleLattice(r, seaV, at.x, at.z) > 0) {
      drop(p, model, m.delta)
      continue
    }
    if (!Number.isFinite(m.delta)) continue
    if (Math.abs(m.delta) > pc.dropMovedM) {
      if (pc.resnapVegetation && isVegetation(p.source) && m.now >= SL + pc.dropBelowSeaM && p.inConvertedRegion !== false) {
        out.edits.resnap.push({ region: p.region, uid: p.uid, y: Math.round((p.position[1] + m.delta) * 1e6) / 1e6 })
      } else drop(p, model, m.delta)
      continue
    }
    // the footprint of what stays: model bounds (glTF model space) rotated by +yaw about +Y
    if (!model || model.kind === 'failed') continue
    const [ax, , az] = model.boundsMin
    const [bx, , bz] = model.boundsMax
    if (bx - ax < 8 && bz - az < 8) continue
    const c = Math.cos(p.yaw)
    const s = Math.sin(p.yaw)
    let worst = 0
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const mx = ax + ((bx - ax) * i) / 8
        const mz = az + ((bz - az) * j) / 8
        const q = toRegion(p.position[0] + mx * c + mz * s, p.position[2] - mx * s + mz * c)
        const d = move(q.x, q.z).delta
        if (Number.isFinite(d)) worst = Math.max(worst, Math.abs(d))
      }
    }
    if (worst <= pc.dropMovedM) continue
    const finding = { region: p.region, uid: p.uid, source: p.source, maxMoveM: Math.round(worst * 100) / 100 }
    if (accept.has(key(p.region, p.uid))) out.accepted.push(finding)
    else out.footprints.push(finding)
  }
  for (const k of byHand) if (!handDropped.has(k)) out.unmatched.push(k)
  return out
}

/** A placement's footprint (model bounds rotated by +yaw about +Y, grown by DROP_FOOTPRINT_PAD_M) in region units. */
export function dropFootprint(p: WorldPlacement, model: WorldModel | undefined,
  toRegion: (gx: number, gz: number) => { x: number; z: number }): DropFootprint {
  const ok = model && model.kind !== 'failed' && model.boundsMin.every(Number.isFinite) && model.boundsMax.every(Number.isFinite)
  const pad = DROP_FOOTPRINT_PAD_M
  const min = DROP_FOOTPRINT_MIN_HALF_M
  const ax = (ok ? Math.min(model.boundsMin[0], -min) : -min) - pad
  const az = (ok ? Math.min(model.boundsMin[2], -min) : -min) - pad
  const bx = (ok ? Math.max(model.boundsMax[0], min) : min) + pad
  const bz = (ok ? Math.max(model.boundsMax[2], min) : min) + pad
  const c = Math.cos(p.yaw)
  const s = Math.sin(p.yaw)
  const corner = (mx: number, mz: number) => {
    const q = toRegion(p.position[0] + mx * c + mz * s, p.position[2] - mx * s + mz * c)
    return [q.x, q.z] as const
  }
  return { corners: [corner(ax, az), corner(bx, az), corner(bx, bz), corner(ax, bz)] }
}
