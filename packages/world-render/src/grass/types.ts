/**
 * Grass seams (docs/GRASS_LIFE.md §1.3, §3.6, §8.1, GL-0; docs/WAVE_PLAN6.md §4.1 step 2, D3, D7, D24). Written by
 * W10-S; the field itself is GL-F's (`grass/{field, window, bake, patch, cull, index}.ts`, reached through
 * scatter.ts's style switch), the shaders GL-S's, the terrain tint GL-T's (`grass/chunks.ts`).
 */
import type { WorldModel } from '../../../convert/src/world/manifest.ts'

/**
 * The mesh tags of GRASS_LIFE's ground cover and wildlife (`mesh.metadata.sroWorld`, BATCHING §3.6): the region
 * batcher never takes a mesh carrying either (batch/types.ts UNBATCHED_TAGS). The retail scatter chunks carry
 * 'scatter' already.
 */
export const SCATTER_TAG = 'scatter'
export const LIFE_TAG = 'life'

/**
 * The placed retail tuft models the new grass replaces (GRASS_LIFE §1.3, Q12; WAVE_PLAN6 D24): 695 low grass
 * placements in jangan-fields (`group_grs01` 299, `grs_weed07` 226, `grs_weed01` 98, `grs_weed02` 37 (skinned),
 * `group_grs03_1` 34, `grass_single03` 1). Hidden on Medium+ where the new grass draws, applied before the region
 * batcher claims a region (objects.ts setHiddenModels, D3). The tall weeds and reeds, the barley, the flowers and the
 * water plants stay as set dressing; Low and the character stage (`hideRetailTufts: false`) keep every one.
 */
export const RETAIL_TUFT_MODELS: readonly string[] = ['group_grs01', 'group_grs03_1', 'grass_single03', 'grs_weed01', 'grs_weed02', 'grs_weed07']

/** The model's file stem (the last part of its retail source path, lower case, without the extension). */
export function modelStem(source: string): string {
  return (source.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '').toLowerCase()
}

/** Whether a manifest model is one of the retail tufts (RETAIL_TUFT_MODELS). */
export function isRetailTuftModel(model: Pick<WorldModel, 'source'>): boolean {
  return RETAIL_TUFT_MODELS.includes(modelStem(model.source))
}

/** The terrain tint define (GL-T's `grass/chunks.ts`, on the Classic terrain chunk and the PBR terrain plugin). */
export const GRASS_TINT_DEFINE = 'SRO_GRASS_TINT'
