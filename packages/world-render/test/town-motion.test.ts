/**
 * TL-M (docs/TOWN_LIFE.md §5; docs/WAVE_PLAN7.md §6.1): the town's motion.
 *
 * 1. The cloth chunk (town/cloth-chunk.ts) in the foliage plugin's `SRO_CLOTH_WIND` slot: the plugin's code with the
 *    define off is the non-cloth plugin's (today's strings); every chunk line sits under the define; the WGSL and GLSL
 *    carry the same function and numbers; no new uniform, sampler or varying (material-budgets.test.ts compiles it).
 * 2. The sway (`clothSway`, the chunk's TS mirror): the pin line holds, the free edge swings downwind on average, a
 *    tent's base and top hold while its middle breathes, below a converter band nothing moves, kind 0 never moves,
 *    calm air (the minimum breeze) still breathes, the amplitude is bounded.
 * 3. The layers (town/fx.ts): puffs lean downwind (more with more wind), fade in and out; leaves fall, land on the
 *    ground, shrink away; the layer finds its emitters, trees and ripple sources in the world's placements, draws
 *    ≤ 2 thin-instanced meshes tagged 'town' (not pickable, no shadows) with lit, non-emissive materials, keeps the
 *    caps, hands the water a fixed-length ripple list (the fountain first), forgets a removed region, and clears the
 *    ripples on dispose; none on Low.
 */
import { ArcRotateCamera, NullEngine, PBRMaterial, Scene, Vector3, Vector4 } from '@babylonjs/core'
import { afterAll, describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import type { RegionListener } from '../src/objects.ts'
import { clothFoliageCode, foliageCode } from '../src/pbr/foliage-plugin.ts'
import { RIPPLE_POINTS_MAX, type RipplePoint } from '../src/pbr/water-town-plugin.ts'
import {
  CLOTH_AMP_MAX_M,
  CLOTH_VERTEX_DEFS_GLSL,
  CLOTH_VERTEX_DEFS_WGSL,
  CLOTH_WORLDPOS_GLSL,
  CLOTH_WORLDPOS_WGSL,
  clothSway,
} from '../src/town/cloth-chunk.ts'
import { FX_CAPS, PUFF_KINDS, TownFx, createTownFx, leafAt, placeAt, puffAt, ruleLocal, type TownFxWorld } from '../src/town/fx.ts'
import { TOWN_TAG } from '../src/town/types.ts'

// ---- 1. the chunk in the slot -------------------------------------------------------------------------------------

describe('the cloth chunk in the SRO_CLOTH_WIND slot', () => {
  const langs = ['wgsl', 'glsl'] as const

  it('with the define off the cloth plugin\'s vertex code preprocesses to the plain plugin\'s (today\'s strings)', () => {
    for (const lang of langs) {
      const plain = foliageCode('vertex', lang)
      const cloth = clothFoliageCode('vertex', lang)
      for (const key of Object.keys(plain)) {
        const extra = cloth[key]!.slice(plain[key]!.length)
        expect(cloth[key]!.startsWith(plain[key]!), `${lang} ${key}`).toBe(true)
        // Everything the slot appends is one `#ifdef SRO_CLOTH_WIND … #endif` block.
        if (extra) {
          expect(extra.startsWith('#ifdef SRO_CLOTH_WIND\n'), `${lang} ${key}`).toBe(true)
          expect(extra.trimEnd().endsWith('#endif'), `${lang} ${key}`).toBe(true)
        }
      }
      expect(clothFoliageCode('fragment', lang)).toEqual(foliageCode('fragment', lang))
    }
  })

  it('carries TL-M\'s chunk: one function in both languages, the same numbers, no new uniform, sampler or varying', () => {
    expect(CLOTH_VERTEX_DEFS_WGSL).toContain('fn sroClothSway(')
    expect(CLOTH_VERTEX_DEFS_GLSL).toContain('vec2 sroClothSway(')
    const nums = (s: string) => (s.match(/\d+\.\d+/g) ?? []).sort()
    expect(nums(CLOTH_VERTEX_DEFS_WGSL)).toEqual(nums(CLOTH_VERTEX_DEFS_GLSL))
    expect(nums(CLOTH_WORLDPOS_WGSL)).toEqual(nums(CLOTH_WORLDPOS_GLSL))
    for (const s of [CLOTH_VERTEX_DEFS_WGSL, CLOTH_VERTEX_DEFS_GLSL, CLOTH_WORLDPOS_WGSL, CLOTH_WORLDPOS_GLSL]) {
      expect(s).not.toMatch(/\buniform\b|\bsampler|\btexture|\bvarying\b|vertexOutputs|\battribute\b/)
    }
    // The WGSL reads the UBO through `uniforms.`, the GLSL by name; neither language leaks into the other.
    expect(CLOTH_WORLDPOS_WGSL).toContain('uniforms.wxB')
    expect(CLOTH_WORLDPOS_GLSL).not.toContain('uniforms.')
    expect(CLOTH_VERTEX_DEFS_GLSL + CLOTH_WORLDPOS_GLSL).not.toMatch(/\blet\b|vec[234]f|select\(|->/)
    expect(CLOTH_VERTEX_DEFS_WGSL + CLOTH_WORLDPOS_WGSL).not.toMatch(/\bfloat\b|\bvec[234]\b(?!f)|\?/)
    // Both moves read the slot's pivot and write worldPos (the slot copies it to vPositionW).
    for (const s of [CLOTH_WORLDPOS_WGSL, CLOTH_WORLDPOS_GLSL]) expect(s).toMatch(/clothPivot[\s\S]*worldPos/)
  })
})

// ---- 2. the sway ----------------------------------------------------------------------------------------------------

describe('clothSway (the chunk\'s mirror)', () => {
  const HANG = 1, AWN = 2, TENT = 3
  const at = (y: number, x = 3, z = -4): [number, number, number] => [x, y, z]
  const mag = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!)
  const times = Array.from({ length: 240 }, (_, i) => i * 0.25)

  it('a hanging piece holds its pin line and swings its free edge, downwind on average', () => {
    const pv: [number, number, number, number] = [10, 2.4, HANG, 1.3]
    for (const t of times) expect(mag(clothSway(pv, at(10), 0.5, t))).toBeLessThan(1e-9)
    let sum = 0
    let peak = 0
    for (const t of times) {
      const o = clothSway(pv, at(7.6), 0.5, t, [0, 1])
      expect(Math.abs(o[0])).toBeLessThan(1e-9) // along the wind (0, 1) only
      sum += o[2]
      peak = Math.max(peak, mag(o))
    }
    expect(sum / times.length).toBeGreaterThan(0.05)
    expect(peak).toBeGreaterThan(0.15)
    expect(peak).toBeLessThan(CLOTH_AMP_MAX_M * 1.1)
    // Halfway down moves less than the free edge (w = u²).
    const half = Math.max(...times.map(t => mag(clothSway(pv, at(8.8), 0.5, t))))
    expect(half).toBeLessThan(peak * 0.4)
  })

  it('a tent holds its base and top and breathes in the middle; an awning flutters up and down', () => {
    const pv: [number, number, number, number] = [2, 3, TENT, 0.4]
    for (const t of times) {
      expect(mag(clothSway(pv, at(2), 0.6, t))).toBeLessThan(1e-6)
      expect(mag(clothSway(pv, at(5), 0.6, t))).toBeLessThan(1e-6)
    }
    expect(Math.max(...times.map(t => mag(clothSway(pv, at(3.5), 0.6, t))))).toBeGreaterThan(0.05)
    const awn: [number, number, number, number] = [3, 1, AWN, 2]
    expect(Math.max(...times.map(t => Math.abs(clothSway(awn, at(2), 0.6, t)[1])))).toBeGreaterThan(0.02)
  })

  it('below a converter band nothing moves (the pennant\'s tent pegs), kind 0 never moves', () => {
    const pennant: [number, number, number, number] = [5.8, 0.95, HANG, 2]
    for (const t of times) {
      expect(mag(clothSway(pennant, at(0.3), 1, t))).toBe(0)
      expect(mag(clothSway([5, 2, 0, 1], at(3.5), 1, t))).toBe(0)
    }
    expect(Math.max(...times.map(t => mag(clothSway(pennant, at(4.9), 1, t))))).toBeGreaterThan(0.1)
  })

  it('calm air (the minimum breeze) still breathes, gently; more wind swings further', () => {
    const pv: [number, number, number, number] = [10, 2.4, HANG, 0.7]
    const calm = Math.max(...times.map(t => mag(clothSway(pv, at(7.6), 0.15, t))))
    const gale = Math.max(...times.map(t => mag(clothSway(pv, at(7.6), 1, t))))
    expect(calm).toBeGreaterThan(0.02)
    expect(calm).toBeLessThan(0.2)
    expect(gale).toBeGreaterThan(calm * 4)
  })
})

// ---- 3. the layers -----------------------------------------------------------------------------------------------------

describe('puffs and leaves (pure)', () => {
  it('a puff rises and leans downwind, more with more wind, and fades in and out', () => {
    const o = new Float32Array(5)
    const e: [number, number, number] = [10, 8, -20]
    const lean = (strength: number) => {
      puffAt('smoke', e, 0, PUFF_KINDS.smoke.life * 0.8, 0, 1, strength, o)
      return { dz: o[2]! - e[2], dy: o[1]! - e[1] }
    }
    const calm = lean(0.15), windy = lean(0.8)
    expect(calm.dy).toBeGreaterThan(4)
    expect(windy.dz).toBeGreaterThan(calm.dz * 2)
    expect(calm.dz).toBeGreaterThan(0)
    puffAt('steam', e, 0, 0, 1, 0, 0.5, o)
    expect(o[4]).toBe(0)
    puffAt('steam', e, 0.999, 0, 1, 0, 0.5, o)
    expect(o[4]).toBeLessThan(0.001)
    puffAt('steam', e, 0.3, 0, 1, 0, 0.5, o)
    expect(o[4]).toBeGreaterThan(0.05)
  })

  it('a leaf falls from the crown, lands on the ground, lies, then shrinks away (deterministic)', () => {
    const crown: [number, number, number, number, number] = [0, 0, 3, 6, 10]
    const o = new Float32Array(6)
    const ys: number[] = []
    let landed = false
    let gone = false
    for (let t = 0; t < 40; t += 0.1) {
      leafAt(crown, 1, 0.37, t, 1, 0, 0.3, o)
      ys.push(o[1]!)
      if (o[5]) {
        landed = true
        expect(o[1]).toBeCloseTo(1.02, 5)
      }
      if (o[3]! < 0.1) gone = true
      expect(o[1]).toBeGreaterThanOrEqual(1.02 - 1e-6)
      expect(o[1]).toBeLessThanOrEqual(10 + 1e-6)
    }
    expect(landed && gone).toBe(true)
    const a = new Float32Array(6), b = new Float32Array(6)
    leafAt(crown, 1, 0.5, 12.3, 0, 1, 0.5, a)
    leafAt(crown, 1, 0.5, 12.3, 0, 1, 0.5, b)
    expect([...a]).toEqual([...b])
  })

  it('places a rule\'s point with the placement\'s rotation', () => {
    const half = Math.SQRT1_2
    // +90° about +Y: model +X goes to world −Z.
    const p = placeAt({ position: [10, 2, 30], rotation: [0, half, 0, half] }, [1, 3, 0])
    expect(p[0]).toBeCloseTo(10, 6)
    expect(p[1]).toBeCloseTo(5, 6)
    expect(p[2]).toBeCloseTo(29, 6)
    expect(ruleLocal({ at: 'bottom' }, { boundsMin: [-1, -10, 0], boundsMax: [1, -4, 2] })).toEqual([0, -10, 1])
  })
})

describe('TownFx (NullEngine, a fake world)', () => {
  const engines: NullEngine[] = []
  afterAll(() => {
    for (const e of engines) e.dispose()
  })

  const model = (index: number, source: string, lo: [number, number, number], hi: [number, number, number]): WorldModel =>
    ({ index, source, glb: 'x.glb', sidecar: null, kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: 0, boundsMin: lo, boundsMax: hi, bytes: 1 }) as unknown as WorldModel
  const place = (x: number, y: number, z: number): WorldPlacement => ({ position: [x, y, z], rotation: [0, 0, 0, 1] }) as unknown as WorldPlacement

  function rig(quality: TownFxWorld['quality'] = 'medium') {
    const engine = new NullEngine()
    engines.push(engine)
    const scene = new Scene(engine)
    const camera = new ArcRotateCamera('cam', 0, 1, 20, new Vector3(100, 0, -100), scene)
    const listeners: RegionListener[] = []
    const ripples: Array<readonly RipplePoint[] | null> = []
    const world: TownFxWorld = {
      quality,
      objects: {
        addRegionListener(l) {
          listeners.push(l)
          return () => listeners.splice(listeners.indexOf(l), 1)
        },
      },
      weather: { u: { wxB: new Vector4(0, 1, 0.4, 0) } },
      water: { setRipplePoints: p => ripples.push(p ? p.map(q => ({ ...q })) : null) },
    }
    const tell = (region: number, m: WorldModel, pl: WorldPlacement[]) =>
      listeners.forEach(l => l.placed(region, m, { index: m.index, source: m.source, heightM: 1, isFoliage: false, kind: 'static' }, [], pl))
    return { scene, camera, world, listeners, ripples, tell }
  }

  it('finds its sources in the placements, draws ≤ 2 tagged meshes with lit materials, keeps the caps', () => {
    const r = rig()
    const fx = createTownFx({ scene: r.scene, world: r.world })!
    expect(fx).toBeInstanceOf(TownFx)
    r.tell(1, model(0, 'res\\bldg\\china\\jangan01\\cj_weap_chimn.bsr', [-3, 0, 0], [12, 8, 18]), [place(95, 0, -110)])
    r.tell(1, model(1, 'res\\nature\\particle\\cj_wf_dr_03.bsr', [-1.2, -10, -2.4], [0, -3.7, 0.5]), [place(97, 7, -80)])
    r.tell(1, model(2, 'res\\npc\\cj_goldfish01.bsr', [0, 0, 0], [0.1, 0.1, 0.1]), [place(110, -3, -95), place(111, -3, -96)])
    r.tell(2, model(3, 'res\\nature\\tree\\tre_maple01.bsr#static', [-9, 0, -8], [8, 17, 9]), [place(105, 0, -100), place(90, 0, -95)])
    r.tell(2, model(4, 'res\\bldg\\china\\jangan01\\cj_table_chair.bsr', [-1.4, 0, -1.7], [1.4, 1.25, 1.5]), Array.from({ length: 30 }, (_, i) => place(80 + i, 0, -100)))
    for (let i = 0; i < 5; i++) fx.update(r.camera, 1 / 60)
    const s = fx.stats()
    expect(s.fxEmitters).toBe(1 + 1 + 30)
    expect(s.fxTrees).toBe(2)
    expect(s.fxPuffs).toBe(FX_CAPS.medium.puffs) // 18 smoke + 12 spray + 6 per table up to the cap
    expect(s.fxLeaves).toBeGreaterThan(0)
    expect(s.fxLeaves).toBeLessThanOrEqual(FX_CAPS.medium.leaves)
    expect(s.fxDraws).toBe(2)
    for (const m of fx.meshes()) {
      expect((m.metadata as { sroWorld?: string }).sroWorld).toBe(TOWN_TAG)
      expect(m.isPickable).toBe(false)
      expect(m.receiveShadows).toBe(false)
      const mat = m.material as PBRMaterial
      expect(mat).toBeInstanceOf(PBRMaterial)
      expect(mat.unlit).toBe(false)
      expect(mat.emissiveTexture).toBeNull()
      expect(mat.emissiveColor.r + mat.emissiveColor.g + mat.emissiveColor.b).toBe(0)
    }
    expect(fx.puffMesh.thinInstanceCount).toBe(FX_CAPS.medium.puffs)
    // Ripples: a fixed-length list, the fountain's fall first at full strength.
    const last = r.ripples.at(-1)!
    expect(last).toHaveLength(RIPPLE_POINTS_MAX)
    expect(last[0]!.strength).toBeGreaterThan(0)
    expect(last[0]!.radiusM).toBeCloseTo(2.2) // H11-W-1: past the falls' curtain
    expect(last[0]!.x).toBeCloseTo(97 + -0.6, 5)
    // A removed region takes its sources with it; the list keeps its length (no water recompile).
    r.listeners.forEach(l => l.removed(2))
    fx.update(r.camera, 1 / 60)
    expect(fx.stats().fxTrees).toBe(0)
    expect(fx.stats().fxLeaves).toBe(0)
    expect(fx.leafMesh.isEnabled()).toBe(false)
    expect(r.ripples.at(-1)).toHaveLength(RIPPLE_POINTS_MAX)
    // Off hides both; dispose clears the water's points and stops listening.
    fx.setEnabled(false)
    fx.update(r.camera, 1 / 60)
    expect(fx.puffMesh.isEnabled()).toBe(false)
    expect(fx.stats().fxDraws).toBe(0)
    fx.dispose()
    expect(r.ripples.at(-1)).toBeNull()
    expect(r.listeners).toHaveLength(0)
    expect(fx.puffMesh.isDisposed()).toBe(true)
  })

  it('puffs drift downwind in the drawn buffer', () => {
    const r = rig()
    const fx = createTownFx({ scene: r.scene, world: r.world })!
    r.tell(1, model(0, 'res\\bldg\\china\\jangan01\\cj_weap_chimn.bsr', [-3, 0, 0], [12, 8, 18]), [place(100, 0, -100)])
    fx.update(r.camera, 3)
    const buf = (fx as unknown as { puffBuf: Float32Array }).puffBuf
    let dz = 0
    for (let i = 0; i < PUFF_KINDS.smoke.per; i++) dz += buf[i * 16 + 14]! - -100
    expect(dz / PUFF_KINDS.smoke.per).toBeGreaterThan(1)
    fx.dispose()
  })

  it('nothing in range: no draw, no ripple list; none on Low', () => {
    const r = rig()
    const fx = createTownFx({ scene: r.scene, world: r.world })!
    r.tell(1, model(0, 'res\\bldg\\china\\jangan01\\cj_weap_chimn.bsr', [-3, 0, 0], [12, 8, 18]), [place(900, 0, 900)])
    fx.update(r.camera, 1 / 60)
    expect(fx.stats().fxDraws).toBe(0)
    expect(fx.puffMesh.isEnabled()).toBe(false)
    expect(r.ripples).toHaveLength(0)
    fx.dispose()
    expect(r.ripples).toHaveLength(0)
    expect(createTownFx({ scene: r.scene, world: { ...r.world, quality: 'low' } })).toBeNull()
  })
})
