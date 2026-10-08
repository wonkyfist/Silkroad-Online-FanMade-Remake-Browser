// Outfits from gear on the licensed bodies (docs/CHARACTERS.md §16.9): item code → pieces by class and slot, the body
// slices the pieces hide, the class / degree palette, the seal's effect, the far colour bake, the fallback without the
// pack's wardrobe.
import { MeshBuilder, NullEngine, PBRMaterial, Scene, Texture } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { CLOTH_DYE_FILES, DYE_REGIONS as CONVERTER_REGIONS, DYE_SHADE_MID as CONVERTER_MID, regionOfMatId } from '../../../packages/convert/src/tools/licensed/cloth-dye.ts'
import { STRIP_W, applyOutfit, clothCode, dilateOwners, outfitStrip, partKeyOf, stripRow, wardrobeOf } from '../src/three/licensed-cloth.ts'
import {
  DYE_REGIONS,
  DYE_SHADE_MID,
  PALETTES,
  SLICE_HIDE_AT,
  bakeOutfit,
  clothFxOf,
  gearOf,
  hiddenSlices,
  outfitFromGear,
  outfitKey,
  paletteKey,
  paletteLinear,
  type WardrobeCoverage,
} from '../src/three/licensed-outfit.ts'

const pieces = (o: ReturnType<typeof outfitFromGear>) => o.pieces.map(p => p.piece).sort()

describe('item codes', () => {
  it('reads class, degree, slot, grade and seal', () => {
    expect(gearOf('ITEM_CH_W_HEAVY_03_BA_B_RARE')).toEqual({ slot: 'chest', cls: 'armour', degree: 3, grade: 'B', seal: 'moon' })
    expect(gearOf('ITEM_CH_M_CLOTHES_01_LA_A')).toEqual({ slot: 'legs', cls: 'garment', degree: 1, grade: 'A', seal: null })
    expect(gearOf('ITEM_CH_M_LIGHT_02_AA_C_RARE')?.seal).toBe('sun')
    expect(gearOf('ITEM_CH_M_LIGHT_02_FA_A')?.slot).toBe('feet')
    // the slot the item is worn in wins over its letters (a test fixture's odd code)
    expect(gearOf('ITEM_CH_M_HEAVY_03_CA_A', 'head')?.slot).toBe('head')
    expect(gearOf('ITEM_CH_SWORD_03_A')).toBeNull()
    expect(gearOf(undefined)).toBeNull()
  })
})

describe('slot → pieces', () => {
  it('garment = top + pants + shoes (+ sleeves on the shoulders); its gloves draw nothing', () => {
    const o = outfitFromGear({ chest: 'ITEM_CH_W_CLOTHES_01_BA_A', legs: 'ITEM_CH_W_CLOTHES_01_LA_A', feet: 'ITEM_CH_W_CLOTHES_01_FA_A', hands: 'ITEM_CH_W_CLOTHES_01_AA_A', shoulders: 'ITEM_CH_W_CLOTHES_01_SA_A' }, 'f')
    expect(pieces(o)).toEqual(['PANTS', 'SHOES', 'SLEEVES', 'TOP'])
  })
  it('protector adds layering, front cloth, gloves, chaps; armour adds skirt, tails, belt, rope', () => {
    const set = (c: string) => ({ chest: `ITEM_CH_M_${c}_02_BA_A`, legs: `ITEM_CH_M_${c}_02_LA_A`, feet: `ITEM_CH_M_${c}_02_FA_A`, hands: `ITEM_CH_M_${c}_02_AA_A`, shoulders: `ITEM_CH_M_${c}_02_SA_A` })
    expect(pieces(outfitFromGear(set('LIGHT'), 'm'))).toEqual(['CHAPS', 'FRONT_CLOTH', 'GLOVES', 'LAYERING', 'PANTS', 'SHOES', 'SLEEVES', 'TOP'])
    expect(pieces(outfitFromGear(set('HEAVY'), 'm'))).toEqual(['BELT', 'CHAPS', 'FLOWERS', 'FRONT_CLOTH', 'GLOVES', 'LAYERING', 'PANTS', 'ROPE', 'SHOES', 'SKIRT', 'SLEEVES', 'TAILS', 'TOP'])
  })
  it('mixed classes work per slot; the girl wears the cut belt without the skirt', () => {
    const o = outfitFromGear({ chest: 'ITEM_CH_W_HEAVY_03_BA_A', legs: 'ITEM_CH_W_CLOTHES_01_LA_A' }, 'f')
    expect(pieces(o)).toEqual(['BELT_CUT', 'FLOWERS', 'FRONT_CLOTH', 'LAYERING', 'PANTS', 'ROPE', 'TOP'])
    expect(o.pieces.find(p => p.piece === 'PANTS')!.gear.cls).toBe('garment')
    expect(o.pieces.find(p => p.piece === 'TOP')!.gear.cls).toBe('armour')
  })
  it('an empty chest / legs shows the lingerie (no top piece for the boy); weapons and accessories draw nothing', () => {
    expect(pieces(outfitFromGear({}, 'f'))).toEqual(['LINGERIE_BOTTOM', 'LINGERIE_TOP'])
    expect(pieces(outfitFromGear({ weapon: 'ITEM_CH_SWORD_01_A', earring: 'ITEM_CH_EARRING_01_A' }, 'm'))).toEqual(['LINGERIE_BOTTOM'])
  })
  it('the outfit key changes with the palette, not with the order of the slots', () => {
    const a = outfitFromGear({ chest: 'ITEM_CH_M_HEAVY_02_BA_A', legs: 'ITEM_CH_M_HEAVY_02_LA_A' }, 'm')
    const b = outfitFromGear({ legs: 'ITEM_CH_M_HEAVY_02_LA_A', chest: 'ITEM_CH_M_HEAVY_02_BA_A' }, 'm')
    const c = outfitFromGear({ chest: 'ITEM_CH_M_HEAVY_02_BA_B', legs: 'ITEM_CH_M_HEAVY_02_LA_A' }, 'm')
    expect(outfitKey(a)).toBe(outfitKey(b))
    expect(outfitKey(a)).not.toBe(outfitKey(c))
  })
})

describe('hidden body slices', () => {
  // bit order: TOP 1, PANTS 2, SHOES 4, GLOVES 8
  const cov: WardrobeCoverage = {
    pieces: ['TOP', 'PANTS', 'SHOES', 'GLOVES'],
    slices: {
      BODY_PART_01: [[1, 99], [0, 1]], // the neck: covered, but never hidden
      BODY_PART_02: [[1, 100]], // chest under the top
      BODY_PART_04: [[2, 40], [2 | 4, 25], [4, 10], [0, 25]], // legs under loose pants: the lower threshold (SLICE_HIDE_LOW)
      BODY_PART_07: [[1, 60], [1 | 8, 34], [8, 3], [0, 3]], // upper arms: top and gloves together
      BODY_PART_06: [[8, 100]], // forearms under gloves
    },
  }
  it('hides a slice only when the worn pieces cover enough of it, never the neck', () => {
    expect([...hiddenSlices(outfitFromGear({ chest: 'ITEM_CH_W_CLOTHES_01_BA_A' }, 'f'), cov)]).toEqual(['BODY_PART_02'])
    // the top alone covers 94 % of the upper arms: they stay (bare where nothing covers them); with the gloves 97 %: hidden
    expect(hiddenSlices(outfitFromGear({ chest: 'ITEM_CH_W_CLOTHES_01_BA_A' }, 'f'), cov).has('BODY_PART_07')).toBe(false)
    expect(hiddenSlices(outfitFromGear({ chest: 'ITEM_CH_W_CLOTHES_01_BA_A', hands: 'ITEM_CH_W_LIGHT_01_AA_A' }, 'f'), cov).has('BODY_PART_07')).toBe(true)
    // the legs: pants alone 65 % stay, pants and shoes 75 % go (SLICE_HIDE_LOW)
    expect(hiddenSlices(outfitFromGear({ legs: 'ITEM_CH_W_CLOTHES_01_LA_A' }, 'f'), cov).has('BODY_PART_04')).toBe(false)
    expect(hiddenSlices(outfitFromGear({ legs: 'ITEM_CH_W_CLOTHES_01_LA_A', feet: 'ITEM_CH_W_CLOTHES_01_FA_A' }, 'f'), cov).has('BODY_PART_04')).toBe(true)
    expect(hiddenSlices(outfitFromGear({ hands: 'ITEM_CH_W_LIGHT_01_AA_A' }, 'f'), cov).has('BODY_PART_06')).toBe(true)
    expect(hiddenSlices(outfitFromGear({}, 'f'), cov).size).toBe(0)
    expect(SLICE_HIDE_AT).toBeGreaterThan(0.9)
  })
})

describe('palette and effects', () => {
  it('every class has D1..D4 rows of every region; degrees beyond clamp', () => {
    for (const rows of Object.values(PALETTES)) {
      expect(rows).toHaveLength(4)
      for (const r of rows) for (const reg of DYE_REGIONS) expect(r[reg]).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(paletteKey(gearOf('ITEM_CH_M_HEAVY_07_BA_A')!)).toBe('a4A')
  })
  it('the classes read apart at the same degree, and the degrees apart in the same class', () => {
    const main = (code: string) => paletteLinear(gearOf(code)!).main
    const dist = (a: number[], b: number[]) => Math.hypot(...a.map((x, i) => x - b[i]!))
    for (const d of ['01', '02', '03']) {
      expect(dist(main(`ITEM_CH_M_CLOTHES_${d}_BA_A`), main(`ITEM_CH_M_LIGHT_${d}_BA_A`))).toBeGreaterThan(0.02)
      expect(dist(main(`ITEM_CH_M_LIGHT_${d}_BA_A`), main(`ITEM_CH_M_HEAVY_${d}_BA_A`))).toBeGreaterThan(0.02)
    }
    expect(dist(main('ITEM_CH_M_HEAVY_01_BA_A'), main('ITEM_CH_M_HEAVY_02_BA_A'))).toBeGreaterThan(0.02)
  })
  it('grade B/C enrich the trim only', () => {
    const a = paletteLinear(gearOf('ITEM_CH_W_LIGHT_03_BA_A')!)
    const c = paletteLinear(gearOf('ITEM_CH_W_LIGHT_03_BA_C')!)
    expect(c.main).toEqual(a.main)
    expect(c.trim).not.toEqual(a.trim)
  })
  it('D1/D2 plain, D3 sheen, D4 sheen + weave; the seal comes from the item', () => {
    expect(clothFxOf(gearOf('ITEM_CH_M_CLOTHES_02_BA_A')!)).toMatchObject({ sheen: 0, weave: 0, seal: 0 })
    expect(clothFxOf(gearOf('ITEM_CH_M_CLOTHES_03_BA_A')!).sheen).toBeGreaterThan(0)
    const d4 = clothFxOf(gearOf('ITEM_CH_M_CLOTHES_04_BA_A')!)
    expect(d4.weave).toBeGreaterThan(0)
    expect(clothFxOf(gearOf('ITEM_CH_M_HEAVY_03_BA_A_RARE')!).seal).toBe(1)
    expect(clothFxOf(gearOf('ITEM_CH_M_HEAVY_03_BA_B_RARE')!).seal).toBe(2)
    expect(clothFxOf(gearOf('ITEM_CH_M_HEAVY_03_BA_C_RARE')!).seal).toBe(3)
    expect(stripRow(gearOf('ITEM_CH_M_HEAVY_03_BA_C_RARE')!)[5 * 4 + 2]).toBe(255) // seal 3 / 3
  })
  it('the shader code exists for both languages and reads the dye map', () => {
    for (const lang of ['glsl', 'wgsl'] as const) {
      const c = clothCode(lang)
      expect(c.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain('sroDye')
      expect(c.CUSTOM_FRAGMENT_UPDATE_ALPHA).toContain('sroStrip')
      expect(c.CUSTOM_FRAGMENT_UPDATE_ALPHA).not.toContain('sroCloth.')
      expect(c.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toContain('sroClothGlow')
    }
  })
})

describe('the converter agrees', () => {
  it('region order, shade mid, MatID colours', () => {
    expect([...CONVERTER_REGIONS]).toEqual([...DYE_REGIONS])
    expect(CONVERTER_MID).toBe(DYE_SHADE_MID)
    expect(DYE_REGIONS[regionOfMatId(161, 94, 123)]).toBe('main')
    expect(DYE_REGIONS[regionOfMatId(0, 255, 255)]).toBe('leather')
    expect(DYE_REGIONS[regionOfMatId(70, 27, 9)]).toBe('trim')
    expect(DYE_REGIONS[regionOfMatId(0, 128, 255)]).toBe('light')
    expect(CLOTH_DYE_FILES.lo).toContain('{g}')
  })
})

describe('the outfit strip and owners', () => {
  it('row i + 1 holds piece i when worn, empty otherwise', () => {
    const o = outfitFromGear({ chest: 'ITEM_CH_W_HEAVY_02_BA_A' }, 'f')
    const st = outfitStrip(o, ['PANTS', 'TOP'])
    const row = (r: number) => Array.from(st.subarray(r * STRIP_W * 4, (r + 1) * STRIP_W * 4))
    expect(row(1).every(v => v === 0)).toBe(true)
    expect(row(2)).toEqual(Array.from(stripRow(o.pieces.find(p => p.piece === 'TOP')!.gear)))
  })
  it('the gutters take a neighbour piece', () => {
    const lo = new Uint8Array(2 * 2 * 4) // 2 × 2 texels, owner in B
    lo[2] = 5
    dilateOwners(lo, 2, 1)
    expect([lo[6], lo[10], lo[14]]).toEqual([5, 5, 0])
  })
})

describe('the far bake', () => {
  it('colours each texel by its owner piece and region at the shade', () => {
    // two texels: TOP main at mid shade, PANTS second at mid shade; a third of an unworn piece
    const lo = new Uint8Array([
      Math.round(255 * Math.pow(DYE_SHADE_MID, 1 / 2.2)), 0, 1, 255,
      Math.round(255 * Math.pow(DYE_SHADE_MID, 1 / 2.2)), 32, 2, 255,
      128, 0, 3, 255,
    ])
    const o = outfitFromGear({ chest: 'ITEM_CH_W_HEAVY_02_BA_A', legs: 'ITEM_CH_W_CLOTHES_02_LA_A' }, 'f')
    const worn = new Map(o.pieces.map(p => [p.piece as string, p.gear]))
    const out = bakeOutfit(lo, ['TOP', 'PANTS', 'SKIRT'], p => (worn.has(p) ? paletteLinear(worn.get(p)!) : null))
    const toS = (v: number) => Math.round(255 * Math.pow(v, 1 / 2.2))
    const top = paletteLinear(worn.get('TOP')!).main
    const pants = paletteLinear(worn.get('PANTS')!).second
    expect(Math.abs(out[0]! - toS(top[0])) <= 1).toBe(true)
    expect(Math.abs(out[5]! - toS(pants[1])) <= 1).toBe(true)
    expect(out[3]).toBe(255)
  })
})

describe('applying to a body', () => {
  it('names: pieces, slices, lingerie through LOD and primitive suffixes; fixed parts are null', () => {
    expect(partKeyOf('SK_RIVERSPIRIT_F_TOP__LOD1')).toBe('TOP')
    expect(partKeyOf('SK_RIVERSPIRIT_F_BELT_cut_primitive1')).toBe('BELT_CUT')
    expect(partKeyOf('SK_RIVERSPIRIT_M_BODY_PART_03__LOD2')).toBe('BODY_PART_03')
    expect(partKeyOf('SK_LINGERIE_F_PANTS')).toBe('LINGERIE_BOTTOM')
    expect(partKeyOf('SK_LINGERIE_F_BRA__LOD1')).toBe('LINGERIE_TOP')
    expect(partKeyOf('SK_RIVERSPIRIT_F_HEAD')).toBeNull()
    expect(partKeyOf('SK_WATERBENDER__LOD1')).toBeNull()
  })

  it('without the wardrobe (an old build, a server without the pack) nothing changes', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const m = MeshBuilder.CreateBox('SK_RIVERSPIRIT_F_SKIRT', {}, scene)
    expect(wardrobeOf({ licensed: { gender: 'f' } })).toBeNull()
    expect(applyOutfit(scene, [m], outfitFromGear({}, 'f'), { licensed: { gender: 'f' } }, null)).toBeNull()
    expect(m.isVisible).toBe(true)
    engine.dispose()
  })

  it('shows the worn pieces, hides the rest and the covered slices, shares palette materials and releases them', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const cloth = new PBRMaterial('MAT_CLOTHES', scene)
    const mk = (n: string) => {
      const m = MeshBuilder.CreateBox(n, {}, scene)
      m.material = /BODY|LINGERIE/.test(n) ? new PBRMaterial('MAT_BODY', scene) : cloth
      return m
    }
    const top = mk('SK_RIVERSPIRIT_F_TOP'), top1 = mk('SK_RIVERSPIRIT_F_TOP__LOD1'), top2 = mk('SK_RIVERSPIRIT_F_TOP__LOD2')
    const skirt = mk('SK_RIVERSPIRIT_F_SKIRT'), chest = mk('SK_RIVERSPIRIT_F_BODY_PART_02'), bra = mk('SK_LINGERIE_F_BRA'), panty = mk('SK_LINGERIE_F_PANTS')
    const sidecar = { licensed: { gender: 'f', wardrobe: { pieces: ['TOP', 'SKIRT'], slices: { BODY_PART_02: [[1, 10]] }, dye: CLOTH_DYE_FILES } } }
    const tex = new Texture(null, scene)
    const assets = { shade: tex, dye: tex, lo: new Uint8ClampedArray(4 * 4 * 4).fill(255), loSize: 4, owner: tex as never }
    const o = outfitFromGear({ chest: 'ITEM_CH_W_LIGHT_03_BA_A_RARE' }, 'f')
    const a = applyOutfit(scene, [top, top1, top2, skirt, chest, bra, panty], o, sidecar, assets)!
    expect(a).not.toBeNull()
    expect([top.isVisible, skirt.isVisible, chest.isVisible, bra.isVisible, panty.isVisible]).toEqual([true, false, false, false, true])
    expect(top.material).not.toBe(cloth)
    expect(top.material).toBe(top1.material) // LOD0 and LOD1 share the outfit material
    expect(top2.material).not.toBe(top.material) // LOD2: the outfit's colour bake
    expect((top2.material as PBRMaterial).albedoTexture?.metadata).toEqual({ sroAtlasSize: 2048 })
    // a second body in the same gear shares; releasing both disposes
    const top0b = mk('SK_RIVERSPIRIT_F_TOP')
    const b = applyOutfit(scene, [top0b], o, sidecar, assets)!
    expect(top0b.material).toBe(top.material)
    const mat = top.material!
    a.release()
    expect(scene.materials.includes(mat)).toBe(true)
    b.release()
    expect(scene.materials.includes(mat)).toBe(false)
    engine.dispose()
  })
})

