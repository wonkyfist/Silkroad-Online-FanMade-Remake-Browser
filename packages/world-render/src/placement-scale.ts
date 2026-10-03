/**
 * S-SCALE (docs/WORLD_EDITOR.md F6, D12; docs/WAVE_PLAN8.md §4.2 step 3, D17): a placement's optional uniform scale
 * (`WorldPlacement.scale`, set in the World Editor: 0.85–1.15 for trees, 0.5–2 for footprint-free props, never
 * buildings), honoured at every compose site (objects.ts, batch/region-batch.ts, batch/trees.ts, ambient-fx.ts,
 * life/spawn.ts, town/fx.ts). Absent = 1, and every site multiplies by exactly 1 then, so an export without scales draws
 * byte for byte as before. The nav keeps the unscaled footprint (it knows position and yaw only).
 */
import type { WorldPlacement } from '../../convert/src/world/manifest.ts'

/** The uniform scale of a placement: its `scale` when finite and positive, else 1 (absent, or a corrupt value). */
export function placementScale(p: Pick<WorldPlacement, 'scale'>): number {
  const s = p.scale
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1
}
