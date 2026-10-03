/**
 * Remastered world models on the PBR path (DRAGON-INT, docs/REMASTER.md "World models"): a retail model with a
 * `remasterVariant` (the converter's remaster step, packages/convert/src/world/remaster-models.ts: a staged glb in the
 * retail model's own space, appended as a 'static' manifest model) loads that variant in its place through
 * `RegionBatcher.modelFor` (region-batch.ts). The Classic path (Low) never sets a batcher, so it keeps drawing the retail
 * model: the Low guard. Placements, nav, ambient rows and uid joins stay the retail model's (objects.ts places the
 * retail model's placements with the variant's cache entry, as for BT-T's static tree variants).
 */
import type { WorldModel } from '../../../convert/src/world/manifest.ts'

/** The suffix on a variant's `source` (the converter's REMASTER_SOURCE_SUFFIX). */
export const REMASTER_SOURCE_SUFFIX = '#remaster'

/** A static retail model's remastered variant, when the manifest has a loadable one; else null. */
export function remasterVariantOf(model: WorldModel, models: readonly WorldModel[]): WorldModel | null {
  const i = model.remasterVariant
  if (model.kind !== 'static' || i === undefined || i === null || i === model.index) return null
  const v = models[i]
  return v && v.index === i && v.kind === 'static' && !!v.glb && v.source === model.source + REMASTER_SOURCE_SUFFIX ? v : null
}
