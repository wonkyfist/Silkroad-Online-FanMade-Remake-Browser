/**
 * The cloth reclass pass (docs/TOWN_LIFE.md §5.1, docs/WAVE_PLAN7.md D13; lane TL-M owns this file after W11-CV's
 * seam): the materials that sway as cloth, each with its kind (and, where a primitive holds more than its cloth, the
 * pin line that names the cloth part), written on the models (manifest `models[].cloth`) by ./passes.ts after the town
 * dressing and before the static variants. The batcher (world-render batch/region-batch.ts `clothPivots`) gives each
 * piece its pivot from this record, and the `+sheen` group's vertex chunk (world-render town/cloth-chunk.ts) sways it.
 *
 * A rule only acts on a model a remaining placement uses, so the census props below cost nothing until TL-B's dressing
 * places them. The cloth class alone does not sway (a `+sheen` piece with no record keeps kind 0): every swaying
 * material is listed here, including the ones `classes.ts` already puts in the cloth class.
 *
 * How the list was chosen (TL-M, 2026-10-01; each glb's primitives rendered with the material highlighted, the shots
 * in the lane's log): the sway weight is per primitive, so a material qualifies when its primitives are cloth only, or
 * when a pin band (`pinY`, `height`) isolates the cloth part (the chunk holds everything outside the band still).
 * Left out, with the reason: `cj_luxury` `CJ_luxu_door*` (the texture is the door sign's, but the primitives are the
 * hall's wall panels), `cj_stab` `CJ_stab_sign` (the signs share one primitive with the stable's window lattice),
 * `cj_resta03` `CJ_resta03_sign` (a sign board standing on the ground), `cj_resta01_tent` (the canopy's corners sit on
 * posts in the same primitive: any sway lifts them off), `cj_weap_sign` (a rigid board), and outside the town the
 * ferries' and the far wall's flags (many flags at many heights in one primitive).
 *
 * Pure: no node:* import.
 */
import type { WorldClothKind } from '../manifest.ts'
import type { ClothPass, ClothReclass, WorldPassContext } from '../passes.ts'

/** One reclass rule: a model (by its resource base name) and the material that sways, with its kind. */
export interface ClothMaterialRule {
  /** Resource base name, lower case, e.g. 'cj_streetstall'. */
  model: string
  /** glTF material name (matched case-insensitively by the renderer). */
  material: string
  kind: WorldClothKind
  /**
   * The pin line in model space (m; hanging, awning: the top; tent: the base) and the cloth's height from it. Both or
   * neither; absent: each primitive's own bounds.
   */
  pinY?: number
  height?: number
  /** Why (the lane's note; not exported). */
  note?: string
}

/** The reclass list (TL-M). */
export const CLOTH_MATERIALS: readonly ClothMaterialRule[] = [
  // ---- in Jangan today ----
  { model: 'cj_resta01', material: 'CJ_resta01_flag', kind: 'hanging', note: 'the restaurant tower\'s long banners (two primitives, each pinned at its own top)' },
  // The 11 military-camp tents' pennants: the band 4.85–5.80 m is the flag; the same primitive's tent pegs (≤ 0.32 m) stay still.
  { model: 'w_cd_mc_tent', material: 'W_CD_mc_buil01_flag', kind: 'hanging', pinY: 5.8, height: 0.95, note: 'the military camp tents\' pennants' },
  // The street stalls' awnings billow between their tied edges (1.95–5.35 m); the counter cloth below stays still.
  { model: 'cj_streetstall', material: 'CJ_StreetStall_02', kind: 'tent', pinY: 1.95, height: 3.4, note: 'the stall awnings' },
  // ---- census props for TL-B's dressing (work/tmp/town-life/props-census.md): inert until placed ----
  { model: 'w_etc02', material: 'w_cd_stor_chun', kind: 'tent', note: 'long awning on poles' },
  { model: 'w_etc03', material: 'w_cd_stor_chun', kind: 'hanging', note: 'the side curtain under the roof' },
  { model: 'thief_vill_stent_01', material: 'thief_vill_bigtent_03', kind: 'tent', note: 'canopy over the boxes' },
  { model: 'thief_vill_object08_01', material: 'thief_vill_object08_02', kind: 'tent', pinY: 2.2, height: 0.65, note: 'the tea stall\'s canopy (the counter front below the band stays still)' },
  { model: 'euro_esteuro_ph_tent1_01', material: 'euro_esteuro_ph18', kind: 'tent', note: 'striped canvas awning' },
]

/** A model source's resource base name: lower case, no directories, no `#variant`, no extension. */
export function clothModelBase(source: string): string {
  return source.replace(/\\/g, '/').toLowerCase().replace(/^.*\//, '').replace(/#.*$/, '').replace(/\.(bsr|glb)$/, '')
}

/** The cloth pass over `rules` (default CLOTH_MATERIALS): a placed model whose source matches gets its rules' materials. */
export function createClothPass(rules: readonly ClothMaterialRule[] = CLOTH_MATERIALS): ClothPass {
  return (ctx: WorldPassContext): ClothReclass[] => {
    if (!rules.length) return []
    const out: ClothReclass[] = []
    const used = new Set<number>()
    for (const p of ctx.placements) for (const i of p.models) used.add(i)
    for (const m of ctx.models) {
      if (m.kind === 'failed' || !used.has(m.index)) continue
      const base = clothModelBase(m.source)
      const mine = rules.filter(r => r.model === base)
      if (!mine.length) continue
      out.push({
        model: m.index,
        cloth: mine.map(r => ({
          material: r.material,
          kind: r.kind,
          ...(r.pinY !== undefined && r.height !== undefined && r.height > 0 ? { pinY: r.pinY, height: r.height } : {}),
        })),
      })
    }
    return out
  }
}
