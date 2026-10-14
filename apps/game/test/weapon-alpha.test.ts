/**
 * Weapon and shield cut-outs (three/weapon-solid.ts): a material with the BMT alpha bit and alpha-0 texels is
 * alpha-tested just above 0 (the openwork goes, the specular mask stays), every other weapon material is opaque, and
 * the rarity shells discard where the weapon is cut.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AssetContainer, Material, MeshBuilder, NullEngine, PBRMaterial, Scene, Texture } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { WEAPON_ALPHA_CUTOFF as CONVERT_CUTOFF, decideAlpha } from '../../../packages/convert/src/gltf/convert.ts'
import { WEAPON_ALPHA_CUTOFF, solidifyWeapon, weaponAlphaOf } from '../src/three/weapon-solid.ts'
import { cutOf } from '../src/world/rarity/shell.ts'

const ROOT = join(import.meta.dirname, '../../../work/out-opt/equipment/china')

interface Side { name: string; flags?: number; texture?: string | null; alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'; alphaReason?: string }

function sidecars(): Array<{ file: string; m: Side }> {
  const out: Array<{ file: string; m: Side }> = []
  for (const kind of ['weapon', 'shield']) {
    for (const f of readdirSync(join(ROOT, kind)).filter(f => f.endsWith('.json'))) {
      const sc = JSON.parse(readFileSync(join(ROOT, kind, f), 'utf8')) as { materials?: Side[] }
      for (const m of sc.materials ?? []) out.push({ file: `${kind}/${f}`, m })
    }
  }
  return out
}

describe('weapon cut-outs', () => {
  it('the converter and the client cut at the same alpha: below DXT3 17/255, above 0', () => {
    expect(WEAPON_ALPHA_CUTOFF).toBe(CONVERT_CUTOFF)
    expect(WEAPON_ALPHA_CUTOFF * 255).toBeGreaterThan(0)
    expect(WEAPON_ALPHA_CUTOFF * 255).toBeLessThan(17)
  })

  it('every weapon and shield material with the alpha bit and alpha-0 texels is alpha-tested', () => {
    const all = sidecars()
    expect(all.length).toBeGreaterThan(20)
    let cut = 0
    for (const { file, m } of all) {
      const how = weaponAlphaOf(m)
      if (/binary|effect layer/i.test(m.alphaReason ?? '')) expect(how, `${file} ${m.name}`).toBe('keep')
      else if (m.flags && m.flags & 0x200) {
        expect(how, `${file} ${m.name}`).toBe('cutout')
        cut++
      } else expect(how, `${file} ${m.name}`).toBe('opaque')
    }
    // the spear and the bow (degrees 1-4 in this build; the degree 8 spear of the owner's report is above its level cap)
    const of = (name: string) => weaponAlphaOf(all.find(a => a.m.name === name)!.m)
    for (const name of ['spear_1_5', 'bow_1_5', 'tblade_1_5', 'sword1_2_3']) {
      expect(of(name), name).toBe('cutout')
    }
    expect(of('blade1_5')).toBe('opaque') // no alpha bit
    expect(cut).toBeGreaterThanOrEqual(10)
  })

  it('solidifyWeapon alpha-tests the cut-outs and makes the rest opaque; shells read the cut', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const c = new AssetContainer(scene)
    const spear = new PBRMaterial('spear_8_12', scene)
    spear.albedoTexture = new Texture(null, scene)
    const blade = new PBRMaterial('blade1_5', scene)
    blade.albedoTexture = new Texture(null, scene)
    blade.transparencyMode = Material.MATERIAL_ALPHABLEND
    c.materials.push(spear, blade)
    const side = {
      materials: [
        { name: 'spear_8_12', flags: 833, alphaMode: 'OPAQUE' as const, alphaReason: 'weapon/shield: texture alpha is a specular/env mask (85.3% partial, 8.5% zero)' },
        { name: 'blade1_5', flags: 320, alphaMode: 'OPAQUE' as const, alphaReason: 'no BMT alpha flag (0x200); texture alpha, if any, is a specular/env mask' },
      ],
    }
    expect(solidifyWeapon(c, '/out-opt/equipment/china/weapon/spear_08.glb', side)).toBe(2)
    expect(spear.transparencyMode).toBe(Material.MATERIAL_ALPHATEST)
    expect(spear.useAlphaFromAlbedoTexture).toBe(true)
    expect(spear.alphaCutOff).toBe(WEAPON_ALPHA_CUTOFF)
    expect(spear.needAlphaTesting()).toBe(true)
    expect(spear.getAlphaTestTexture()).toBe(spear.albedoTexture)
    expect(blade.transparencyMode).toBe(Material.MATERIAL_OPAQUE)
    // idempotent
    expect(solidifyWeapon(c, '/out-opt/equipment/china/weapon/spear_08.glb', side)).toBe(0)
    const mesh = MeshBuilder.CreatePlane('p', {}, scene)
    mesh.material = spear
    expect(cutOf(mesh)).toEqual({ texture: spear.albedoTexture, cutoff: WEAPON_ALPHA_CUTOFF })
    mesh.material = blade
    expect(cutOf(mesh)).toBeNull()
    scene.dispose()
    engine.dispose()
  })

  it('the converter alpha-tests a weapon texture with alpha-0 openwork and keeps a pure specular mask opaque', () => {
    const tex = (values: number[]) => new Uint8Array(values.flatMap(a => [128, 128, 128, a]))
    const flagged = { flags: 0x200 }
    const openwork = decideAlpha(flagged, tex([0, 17, 34, 34, 51, 68, 85, 255]), true)
    expect(openwork.mode).toBe('MASK')
    expect(openwork.cutoff).toBe(CONVERT_CUTOFF)
    expect(decideAlpha(flagged, tex([17, 34, 34, 51, 68, 85, 255]), true).mode).toBe('OPAQUE')
    expect(decideAlpha({ flags: 0 }, tex([0, 17, 34]), true).mode).toBe('OPAQUE')
    // not a weapon: partial alpha is coverage, blended as before
    expect(decideAlpha(flagged, tex([0, 17, 34, 34, 51, 68, 85, 255]), false).mode).toBe('BLEND')
  })
})
