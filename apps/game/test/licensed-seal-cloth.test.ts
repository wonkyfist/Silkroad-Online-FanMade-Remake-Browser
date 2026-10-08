// The seal armour's animated looks, the earring, dirt and blood (docs/CHARACTERS.md §16.9).
import { MeshBuilder, NullEngine, PBRMaterial, Scene, Texture } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { CLOTH_DYE_FILES } from '../../../packages/convert/src/tools/licensed/cloth-dye.ts'
import { HEM_PARTICLES, hemParticleAt } from '../src/three/licensed-cloth-fx.ts'
import { STRIP_H, STRIP_W, applyOutfit, clothClockOf, clothCode, earringStrip } from '../src/three/licensed-cloth.ts'
import { earringOf, farPaletteLinear, outfitFromGear, outfitKey, outfitSeals, paletteLinear, gearOf, wearKey } from '../src/three/licensed-outfit.ts'
import { WEAR_HYSTERESIS, WEAR_STEPS, WearModel, levelOf } from '../src/world/features/cloth-wear.ts'

describe('the earring', () => {
  it('the girl wears it (the chest class palette), the boy has no mesh', () => {
    expect(earringOf('ITEM_CH_EARRING_04_C_RARE', 'protector')).toEqual({ slot: 'earring', cls: 'protector', degree: 4, grade: 'C', seal: 'sun' })
    expect(earringOf('ITEM_CH_SWORD_01_A')).toBeNull()
    const f = outfitFromGear({ chest: 'ITEM_CH_W_LIGHT_02_BA_A', earring: 'ITEM_CH_EARRING_02_A' }, 'f')
    expect(f.earring?.cls).toBe('protector')
    expect(outfitKey(f)).toContain('EARRINGS=')
    expect(outfitFromGear({ earring: 'ITEM_CH_EARRING_02_A' }, 'm').earring).toBeUndefined()
  })
  it('its strip: every row the item, the jewel flag on', () => {
    const st = earringStrip(earringOf('ITEM_CH_EARRING_03_B_RARE')!)
    expect(st.length).toBe(STRIP_W * STRIP_H * 4)
    for (const r of [0, 7, STRIP_H - 1]) expect(st[(r * STRIP_W + 6) * 4]).toBe(255)
  })
})

describe('the seals', () => {
  it('the shader animates by the clock and compiles the seal and the wear only where used', () => {
    for (const lang of ['glsl', 'wgsl'] as const) {
      const c = clothCode(lang).CUSTOM_FRAGMENT_UPDATE_ALPHA
      expect(c).toContain('#ifdef SROSEAL')
      expect(c).toContain('#ifdef SROWEAR')
      expect(c).toMatch(/sroClothK\.y/)
      expect(c).toContain('sroLink') // the constellation lines
      // derivatives before any branch (WGSL uniformity)
      expect(c.indexOf('fwidth')).toBeLessThan(c.indexOf('if ('))
    }
  })
  it('the far bodies get a static tint per seal; plain items keep their palette', () => {
    const star = gearOf('ITEM_CH_W_HEAVY_04_BA_A_RARE')!
    const plain = gearOf('ITEM_CH_W_HEAVY_04_BA_A')!
    expect(farPaletteLinear(plain)).toEqual(paletteLinear(plain))
    const m = farPaletteLinear(star).main
    expect(m[2]).toBeGreaterThan(m[1] * 2) // violet
    expect(outfitSeals(outfitFromGear({ chest: 'ITEM_CH_W_HEAVY_04_BA_C_RARE', legs: 'ITEM_CH_W_HEAVY_04_LA_A_RARE' }, 'f')).sort()).toEqual(['star', 'sun'])
  })
  it('hem particles: deterministic, alpha in 0..1, embers rise', () => {
    for (const tier of ['star', 'moon', 'sun'] as const)
      for (let i = 0; i < HEM_PARTICLES[tier]; i++)
        for (const s of [0, 1.3, 7.7]) {
          const a = hemParticleAt(tier, i, 0.42, s)
          expect(a).toEqual(hemParticleAt(tier, i, 0.42, s))
          expect(a.alpha).toBeGreaterThanOrEqual(0)
          expect(a.alpha).toBeLessThanOrEqual(1)
        }
    const ups = [0.5, 1.0, 1.5].map(s => hemParticleAt('sun', 0, 0.1, s).up)
    expect(Math.max(...ups)).toBeLessThan(0.8)
  })
})

describe('wear', () => {
  it('levels from the amounts; heavy hits and kills bleed, running dirties, town and repair clean', () => {
    expect(levelOf(0)).toBe(0)
    expect(levelOf(WEAR_STEPS[2])).toBe(3)
    const m = new WearModel()
    m.hitTaken(0.02)
    const light = m.blood
    const h = new WearModel()
    h.hitTaken(0.2)
    expect(h.blood).toBeGreaterThan(light * 5)
    for (let i = 0; i < 5; i++) h.kill()
    expect(h.levels().blood).toBeGreaterThanOrEqual(2)
    const r = new WearModel()
    r.tick(600, { moving: true, inTown: false, rain: true })
    expect(r.levels().dirt).toBeGreaterThanOrEqual(2)
    r.tick(120, { moving: false, inTown: true, rain: false })
    expect(r.levels().dirt).toBe(0)
    h.repair()
    expect(h.levels()).toEqual({ dirt: 0, blood: 0 })
    expect(wearKey({ dirt: 0, blood: 0 })).toBe('')
    expect(wearKey({ dirt: 2, blood: 1 })).toBe('w21')
  })
  it('a level drops only WEAR_HYSTERESIS under its step (no flip every second at the line)', () => {
    expect(levelOf(WEAR_STEPS[0] - 0.01)).toBe(0)
    expect(levelOf(WEAR_STEPS[0] - 0.01, 1)).toBe(1)
    expect(levelOf(WEAR_STEPS[0] - WEAR_HYSTERESIS - 0.01, 1)).toBe(0)
    expect(levelOf(WEAR_STEPS[1] - 0.01, 0)).toBe(1) // rising: no hysteresis
    const m = new WearModel()
    m.blood = WEAR_STEPS[0] + 0.01
    expect(m.levels(true).blood).toBe(1)
    m.blood = WEAR_STEPS[0] - 0.02
    expect(m.levels(true).blood).toBe(1)
    expect(m.levels(false).blood).toBe(0)
  })
  it('a wear level is its own shared material; the clean one is the plain key', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const cloth = new PBRMaterial('MAT_CLOTHES', scene)
    const mk = (n: string) => {
      const m = MeshBuilder.CreateBox(n, {}, scene)
      m.material = cloth
      return m
    }
    const sidecar = { licensed: { gender: 'f', wardrobe: { pieces: ['TOP'], slices: {}, dye: CLOTH_DYE_FILES } } }
    const tex = new Texture(null, scene)
    const assets = { shade: tex, dye: tex, lo: new Uint8ClampedArray(4 * 4 * 4).fill(255), loSize: 4, owner: tex as never, wear: tex }
    const o = outfitFromGear({ chest: 'ITEM_CH_W_HEAVY_04_BA_A_RARE', earring: 'ITEM_CH_EARRING_04_A_RARE' }, 'f')
    const a = mk('SK_RIVERSPIRIT_F_TOP'), b = mk('SK_RIVERSPIRIT_F_TOP'), ear = mk('SK_RIVERSPIRIT_F_EARRINGS')
    const clean = applyOutfit(scene, [a, ear], o, sidecar, assets)!
    const dirty = applyOutfit(scene, [b], o, sidecar, assets, undefined, { dirt: 2, blood: 0 })!
    expect(clean.key).toBe(outfitKey(o))
    expect(dirty.key).toBe(`${outfitKey(o)}|w20`)
    expect(a.material).not.toBe(b.material)
    expect(ear.material).not.toBe(cloth) // the earring's own colours
    expect(ear.material).not.toBe(a.material)
    expect(clothClockOf(scene)).toBe(clothClockOf(scene))
    clean.release()
    dirty.release()
    engine.dispose()
  })
})
