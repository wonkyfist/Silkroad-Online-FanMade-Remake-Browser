/**
 * Weapons and shields are solid (docs/RARITY.md §5.8). Retail weapon textures carry a specular/env mask in their alpha
 * (79-94 % of the texels partial: sword1_2_3, spear_1_5, tblade_1_5, bow_1_5, Shield_04), not coverage; their BMT
 * alpha bit made the converter export them as BLEND, and the actor texture swap (world-render ActorMaps) then turned a
 * blended material into an alpha test at 0.5 on that mask: the spear head drew only its outline, see-through in the
 * middle. The converter now exports them OPAQUE (gltf/convert.ts `isWeaponPath`); this puts the same rule on glbs
 * converted before, at load, before any swap reads the material.
 */
import { Material, PBRMaterial, type AssetContainer } from '@babylonjs/core'

const WEAPON_GLB = /\/(item|equipment)\/[^/]+\/(weapon|shield)\//i

/** A weapon or shield glb (`/out[-opt]/equipment|item/<race>/weapon|shield/...`). */
export function isWeaponGlb(glb: string): boolean {
  return WEAPON_GLB.test(glb)
}

/** The sidecar's per-material decision (absent: decided by the material). */
interface SideMaterial {
  name?: string
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'
  alphaReason?: string
}

/**
 * A weapon or shield material whose alpha is real coverage: a binary cut-out (the arrows' fletching: mostly 0 or 255)
 * or an effect card (shield_02's layer, mostly alpha 0). Everything else on a weapon is a specular mask.
 */
export function isCoverage(side: SideMaterial | undefined): boolean {
  const r = side?.alphaReason ?? ''
  return /binary|effect layer/i.test(r)
}

/**
 * Makes the weapon and shield materials of `container` opaque unless their alpha is real coverage (isCoverage). The
 * equipment set's spear_03 and bow_03 were alpha-tested at 128 ("cuts 39 % / 49 % of the surface"): hollow heads.
 * Returns how many it changed.
 */
export function solidifyWeapon(container: AssetContainer, glb: string, sidecar: { materials?: SideMaterial[] } | null): number {
  if (!isWeaponGlb(glb)) return 0
  let n = 0
  for (const m of container.materials) {
    if (!(m instanceof PBRMaterial)) continue
    const side = sidecar?.materials?.find(s => s.name === m.name)
    if (isCoverage(side)) continue
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
