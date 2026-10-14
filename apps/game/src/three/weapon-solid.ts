/**
 * Weapons and shields: solid, with their openwork cut out (docs/RARITY.md §5.8, §5.11). Retail weapon textures (DXT3)
 * carry two things in their alpha: a specular/env mask in the partial values (79-94 % of the texels: sword1_2_3,
 * spear_1_5, tblade_1_5, bow_1_5, Shield_04), and, on a material with the BMT alpha bit (0x200), cut-outs at exactly
 * alpha 0: the openwork between a degree 8 spear's star blades, the bow and blade holes. The mask is not coverage: an
 * alpha test at 128 (or a blend) drew the spear head as an outline, see-through in the middle. So a flagged material
 * is alpha-tested just above 0 (WEAPON_ALPHA_CUTOFF: the smallest non-zero DXT3 alpha is 17/255): the cut-outs go,
 * the masked metal stays. An unflagged one (blade1_5, Shield_01) stays opaque, its alpha only a mask.
 * The converter writes the same rule (gltf/convert.ts decideAlpha); this applies it at load to glbs converted before,
 * before any texture swap reads the material.
 */
import { Material, PBRMaterial, type AssetContainer } from '@babylonjs/core'

const WEAPON_GLB = /\/(item|equipment)\/[^/]+\/(weapon|shield)\//i

/** Alpha-test cutoff of a weapon's cut-outs: alpha 0 goes, the specular mask (>= 17/255 in DXT3) stays. */
export const WEAPON_ALPHA_CUTOFF = 8 / 255
/** BMT flag: the material is alpha-tested (BMT_FLAG.alpha). */
const BMT_ALPHA = 0x200

/** A weapon or shield glb (`/out[-opt]/equipment|item/<race>/weapon|shield/...`). */
export function isWeaponGlb(glb: string): boolean {
  return WEAPON_GLB.test(glb)
}

/** The sidecar's per-material decision (absent: decided by the material). */
interface SideMaterial {
  name?: string
  flags?: number
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'
  alphaCutoff?: number
  alphaReason?: string
}

/**
 * A weapon or shield material whose alpha is real coverage: a binary cut-out (the arrows' fletching: mostly 0 or 255)
 * or an effect card (shield_02's layer, mostly alpha 0). It keeps the converter's alpha mode.
 */
export function isCoverage(side: SideMaterial | undefined): boolean {
  const r = side?.alphaReason ?? ''
  return /binary|effect layer/i.test(r)
}

/**
 * How a weapon or shield material draws: 'keep' (coverage, as converted), 'cutout' (BMT alpha bit: alpha-tested at
 * WEAPON_ALPHA_CUTOFF, which only ever removes alpha-0 texels: a texture without any loses nothing) or 'opaque' (no
 * alpha bit: the alpha is only a mask). The equipment pass's "% zero" samples six points per triangle and misses small
 * openwork, so it is not consulted.
 */
export function weaponAlphaOf(side: SideMaterial | undefined): 'keep' | 'cutout' | 'opaque' {
  if (isCoverage(side)) return 'keep'
  return side?.flags && side.flags & BMT_ALPHA ? 'cutout' : 'opaque'
}

/**
 * Puts the weapon and shield materials of `container` on weaponAlphaOf: cut-outs alpha-tested at WEAPON_ALPHA_CUTOFF
 * (the shadow and depth passes cut the same: they read getAlphaTestTexture), the rest opaque. Returns how many it
 * changed.
 */
export function solidifyWeapon(container: AssetContainer, glb: string, sidecar: { materials?: SideMaterial[] } | null): number {
  if (!isWeaponGlb(glb)) return 0
  let n = 0
  for (const m of container.materials) {
    if (!(m instanceof PBRMaterial)) continue
    const side = sidecar?.materials?.find(s => s.name === m.name)
    const how = weaponAlphaOf(side)
    if (how === 'keep') continue
    if (how === 'cutout' && m.albedoTexture) {
      if (m.transparencyMode === Material.MATERIAL_ALPHATEST && m.useAlphaFromAlbedoTexture && m.alphaCutOff === WEAPON_ALPHA_CUTOFF) continue
      m.transparencyMode = Material.MATERIAL_ALPHATEST
      m.useAlphaFromAlbedoTexture = true
      m.alphaCutOff = WEAPON_ALPHA_CUTOFF
      m.opacityTexture = null
      m.albedoTexture.hasAlpha = true
      n++
      continue
    }
    const mode = m.transparencyMode
    if ((mode === null || mode === Material.MATERIAL_OPAQUE) && !m.useAlphaFromAlbedoTexture && !m.opacityTexture) continue
    m.transparencyMode = Material.MATERIAL_OPAQUE
    m.useAlphaFromAlbedoTexture = false
    m.opacityTexture = null
    if (m.albedoTexture) m.albedoTexture.hasAlpha = false
    n++
  }
  return n
}
