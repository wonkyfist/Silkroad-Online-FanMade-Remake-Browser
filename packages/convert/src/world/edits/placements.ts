/**
 * The "world edits" placement pass (step 6 of ../passes.ts; docs/WORLD_EDITOR.md §3.2, §3.6, §4.1, §4.6, F3-F5).
 * Node-free.
 *
 * - placements.json is lowered by the shared `lowerPlacementEdits` (packages/shared world-edits, the editor's own
 *   function): a move is C9's drop + an add of the same (region, uid) inside its region, a drop + an add under a fresh
 *   editor uid (0xE000-0xEFFF) of the new owner otherwise; adds take the lowest free editor uid in file order. Its
 *   problems (an unknown key, "the object changed / moved under your edit", no free uid, an unknown model) are
 *   warnings and those edits are skipped: the converter never aborts on content (Publish validates first).
 * - An add names its model by source path; the placement is built from the export's first placement of that source
 *   (objId, models, compound, flags, group: what object.ifo gave it), so a planted carrier is the same object as a
 *   retail one. A source no placement uses cannot be added this wave (the editor converts nothing, D45).
 * - **Objects on edited ground** (§4.1, "keep objects on the ground", default on): a placement the edits leave in
 *   place, standing where the ground moved, follows the ground's change under its origin (its exported clearance
 *   kept) when it is vegetation or has no collision navmesh; anything else with a footprint (buildings, walls, bridges)
 *   never moves by itself and is listed for the Publish checks (WE-N's check 6).
 */
import {
  lowerPlacementEdits, placementKey, yawRotation, type WorldEditAdd,
} from '../../../../shared/src/world-edits/index.ts'
import type { WorldPlacement } from '../manifest.ts'
import type { PlacementRef, WorldEditsEdits, WorldEditsPass, WorldPassContext } from '../passes.ts'
import type { EditLattice, WorldEditsLayers } from './layers.ts'

/** Ground changes under an origin smaller than this (m) leave the object alone. */
export const RESNAP_MIN_M = 0.001

export interface EditsPassOptions {
  layers: WorldEditsLayers
  lattice: EditLattice
  /** Vegetation (trees, grass, flowers, reeds: ../static-variants.ts isFoliageModel). */
  isVegetation(source: string): boolean
  /** The object carries a collision navmesh (an instance in the export's nav). */
  footprint(objId: number): boolean
  /** Receives the problems (as warnings) and the pass's outcome for the after-pass hooks. */
  onResult?(r: EditsPassOutcome): void
}

export interface ListedProp {
  region: number
  uid: number
  source: string
  /** The ground's change under its origin (m). */
  deltaM: number
}

export interface EditsPassOutcome {
  /** The placements and models the pass saw (before the edits). */
  before: readonly WorldPlacement[]
  edits: WorldEditsEdits
  /** The keys (`region:uid`) the edits dropped (moves included), added (moves included) and re-snapped. */
  dropped: ReadonlySet<string>
  added: ReadonlySet<string>
  resnapped: ReadonlySet<string>
  /** Objects with a footprint standing on moved ground (never moved by the pass). */
  listed: ListedProp[]
  problems: string[]
}

/** The pass (WorldEditsPass) for a layer set. */
export function createEditsPass(opts: EditsPassOptions): WorldEditsPass {
  return (ctx: WorldPassContext) => {
    const out = editsPassResult(ctx, opts)
    for (const p of out.problems) ctx.warnings.push(`edits: ${p}`)
    opts.onResult?.(out)
    return out.edits
  }
}

/** The pass's work (exported for the tests and the editor's preview). */
export function editsPassResult(ctx: WorldPassContext, opts: EditsPassOptions): EditsPassOutcome {
  const file = opts.layers.placements ?? { move: [], drop: [], add: [] }
  const exported = new Set(ctx.regions.map(r => r.id))
  // the first placement of each source (file order): an add's template
  const template = new Map<string, WorldPlacement>()
  for (const p of ctx.placements) {
    const k = p.source.toLowerCase()
    if (!template.has(k)) template.set(k, p)
  }
  const create = (a: WorldEditAdd, region: number, uid: number): WorldPlacement | null => {
    const t = template.get(a.source.toLowerCase())
    if (!t) return null
    const placed: WorldPlacement = {
      objId: t.objId, source: t.source, models: t.models.slice(), compound: t.compound,
      position: [a.position[0], a.position[1], a.position[2]],
      rotation: yawRotation(a.yaw), yaw: a.yaw,
      flags: { ...t.flags }, staticFlag: t.staticFlag, uid, region, group: t.group, inConvertedRegion: exported.has(region),
    }
    if (a.scale !== undefined && a.scale !== 1) placed.scale = a.scale
    return placed
  }
  const lowered = lowerPlacementEdits(ctx.placements, file, {
    originRegion: ctx.origin, create,
    rehome: (p, region) => ({ ...p, inConvertedRegion: exported.has(region) }),
  })
  const dropped = new Set(lowered.drop.map(d => placementKey(d.region, d.uid)))
  const added = new Set(lowered.add.map(p => placementKey(p.region, p.uid)))

  // objects left in place on moved ground
  const resnap: Array<PlacementRef & { y: number }> = []
  const resnapped = new Set<string>()
  const listed: ListedProp[] = []
  if (opts.layers.height.size) {
    for (const p of ctx.placements) {
      const key = placementKey(p.region, p.uid)
      if (dropped.has(key)) continue
      const d = opts.lattice.deltaAtPosition(p.position, ctx.origin)
      if (!(Math.abs(d) >= RESNAP_MIN_M)) continue
      if (opts.isVegetation(p.source) || !opts.footprint(p.objId)) {
        resnap.push({ region: p.region, uid: p.uid, y: Math.round((p.position[1] + d) * 1e4) / 1e4 })
        resnapped.add(key)
      } else listed.push({ region: p.region, uid: p.uid, source: p.source, deltaM: Math.round(d * 1e4) / 1e4 })
    }
  }
  return {
    before: ctx.placements,
    edits: { drop: lowered.drop, resnap, add: lowered.add, models: [] },
    dropped, added, resnapped, listed, problems: lowered.problems,
  }
}
