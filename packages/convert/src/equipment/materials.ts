/**
 * Alpha mode of equipment materials.
 *
 * BMT has one alpha flag (0x200, openroad: alpha test with reference 128). gltf/convert.ts picks MASK or BLEND from
 * the texture's alpha histogram, which suits hair and fur, but most armour textures carry the flag while their
 * alpha is a mask, not coverage: sampled where the meshes' UVs actually land, 60-100 % of the surface of heavy and
 * protector parts is below 128, which an alpha test would cut away, while true cut-outs (fringes, lace, the
 * two-sided brim of clothes_03_ha) lose at most 35 % (vSRO 1.188, degrees 1-3, both genders; nothing lies between
 * 35 % and 60 %). So for equipment: more than half the surface below 128 -> OPAQUE (the alpha is a mask), unless
 * that surface is mostly alpha 0 (an effect card); otherwise MASK with cutoff 0.5. See equipmentAlphaMode.
 */
import type { Document, Material } from '@gltf-transform/core'
import { decodeDds, parseDdj } from '@sro/formats'
import type { ReadFile, Sidecar } from '../gltf/convert.ts'

export const MASK_SURFACE_LIMIT = 0.5
const BARYCENTRIC_SAMPLES: ReadonlyArray<readonly [number, number]> = [[1 / 3, 1 / 3], [2 / 3, 1 / 6], [1 / 6, 2 / 3], [1 / 6, 1 / 6], [0.5, 0.25], [0.25, 0.5]]

export interface AlphaImage {
  width: number
  height: number
  rgba: Uint8Array
}

/** Area-weighted fraction of a primitive's surface whose sampled texture alpha is below 128 (wrapping UVs). */
export function surfaceAlpha(positions: ArrayLike<number>, uvs: ArrayLike<number>, indices: ArrayLike<number>,
  image: AlphaImage): { below: number; zero: number } {
  const alphaAt = (u: number, v: number) => {
    const x = Math.min(image.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * image.width)))
    const y = Math.min(image.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * image.height)))
    return image.rgba[(y * image.width + x) * 4 + 3]!
  }
  let cut = 0
  let zero = 0
  let total = 0
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]!
    const b = indices[t + 1]!
    const c = indices[t + 2]!
    const e1 = [0, 1, 2].map(k => positions[b * 3 + k]! - positions[a * 3 + k]!)
    const e2 = [0, 1, 2].map(k => positions[c * 3 + k]! - positions[a * 3 + k]!)
    const area = Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!)
    for (const [wa, wb] of BARYCENTRIC_SAMPLES) {
      const wc = 1 - wa - wb
      const u = uvs[a * 2]! * wa + uvs[b * 2]! * wb + uvs[c * 2]! * wc
      const v = uvs[a * 2 + 1]! * wa + uvs[b * 2 + 1]! * wb + uvs[c * 2 + 1]! * wc
      total += area
      const alpha = alphaAt(u, v)
      if (alpha < 128) cut += area
      if (alpha === 0) zero += area
    }
  }
  return total > 0 ? { below: cut / total, zero: zero / total } : { below: 0, zero: 0 }
}

export interface AlphaDecision {
  material: string
  /** Surface fraction with alpha < 128 and with alpha 0. */
  below: number
  zero: number
  /** null: left as gltf/convert.ts decided (an effect layer). */
  mode: 'OPAQUE' | 'MASK' | null
}

/**
 * The rule for one material: mostly below 128 but mostly non-zero -> the alpha is a mask (OPAQUE); mostly below 128
 * and mostly zero -> an effect layer such as shield_02's 8-vertex card (left as converted); otherwise an alpha
 * test at 128 (MASK 0.5).
 */
export function equipmentAlphaMode(below: number, zero: number): 'OPAQUE' | 'MASK' | null {
  if (below <= MASK_SURFACE_LIMIT) return 'MASK'
  return zero < MASK_SURFACE_LIMIT ? 'OPAQUE' : null
}

/** Re-decides the alpha mode of every non-opaque material of a converted equipment document; updates the sidecar. */
export function fixEquipmentAlpha(doc: Document, sidecar: Sidecar, read: ReadFile): AlphaDecision[] {
  const images = new Map<string, AlphaImage>()
  const byMaterial = new Map<Material, { below: number; zero: number; weight: number }>()
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const material = prim.getMaterial()
      if (!material || material.getAlphaMode() === 'OPAQUE') continue
      const info = sidecar.materials.find(m => m.name === material.getName())
      if (!info?.texture) continue
      let image = images.get(info.texture)
      if (!image) {
        image = decodeDds(parseDdj(read(info.texture)).dds)
        images.set(info.texture, image)
      }
      const idx = prim.getIndices()!.getArray()!
      const s = surfaceAlpha(prim.getAttribute('POSITION')!.getArray()!, prim.getAttribute('TEXCOORD_0')!.getArray()!, idx, image)
      const acc = byMaterial.get(material) ?? { below: 0, zero: 0, weight: 0 }
      const w = idx.length / 3
      acc.below += s.below * w
      acc.zero += s.zero * w
      acc.weight += w
      byMaterial.set(material, acc)
    }
  }
  const decisions: AlphaDecision[] = []
  for (const [material, acc] of byMaterial) {
    const below = acc.weight > 0 ? acc.below / acc.weight : 0
    const zero = acc.weight > 0 ? acc.zero / acc.weight : 0
    const mode = equipmentAlphaMode(below, zero)
    const info = sidecar.materials.find(m => m.name === material.getName())
    const pct = (x: number) => `${(x * 100).toFixed(0)}%`
    if (mode) {
      material.setAlphaMode(mode)
      if (mode === 'MASK') material.setAlphaCutoff(0.5)
    }
    if (info) {
      if (mode) {
        info.alphaMode = mode
        if (mode === 'MASK') info.alphaCutoff = 0.5
        else delete info.alphaCutoff
      }
      info.alphaReason = mode === 'OPAQUE'
        ? `equipment: BMT alpha flag but ${pct(below)} of the surface samples alpha < 128 (${pct(zero)} zero): the alpha is a mask`
        : mode === 'MASK'
          ? `equipment: BMT alpha test (reference 128) cuts ${pct(below)} of the surface`
          : `equipment: effect layer (${pct(zero)} of the surface has alpha 0); kept: ${info.alphaReason}`
    }
    decisions.push({ material: material.getName(), below, zero, mode })
  }
  return decisions
}

/**
 * BMT emissive is a Direct3D fixed-function material term: the lit colour (emissive + ambient + diffuse lighting) is
 * modulated by the texture, so the emissive part is tinted by the texture too. gltf/convert.ts writes it as a flat
 * glTF emissiveFactor, which glTF adds after the texture: heavy armour (emissive 0.26) then looks washed out. For
 * equipment the base colour texture doubles as the emissive texture, which restores texture x emissive.
 */
export function fixEquipmentEmissive(doc: Document): string[] {
  const fixed: string[] = []
  for (const material of doc.getRoot().listMaterials()) {
    const texture = material.getBaseColorTexture()
    if (!texture || material.getEmissiveTexture() || !material.getEmissiveFactor().some(c => c > 0)) continue
    material.setEmissiveTexture(texture)
    fixed.push(material.getName())
  }
  return fixed
}
