/**
 * The lighting upgrade (docs/LIGHTING.md): the sun-lit ground bounce in the ambient SH, the eye adaptation's pure
 * logic (key, target, temporal step, storms), the plan (Medium/High/Ultra adapt, Low never), PCSS on High/Ultra, and
 * the lantern glow's light pick.
 */
import { NullEngine, PointLight, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { RENDER_PRESETS, type GpuInfo } from '../src/index.ts'
import { ADAPT, adaptKey, adaptStep, adaptTargetEV, nightLift, storminess } from '../src/render/adaptation.ts'
import { GROUND_BOUNCE, addGroundSH, ambientToSH, groundBounceRadiance, shIrradiance } from '../src/render/lighting.ts'
import { LIGHT_LOOK } from '../src/render/look.ts'
import { planPost } from '../src/render/post.ts'
import { csmSettings } from '../src/render/shadows.ts'
import { GLOW_MAX_M, pickGlowLights, type GlowLight } from '../src/render/volumetrics/shafts.ts'

const GPU: GpuInfo = { maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 16, features: [], vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false }

describe('sun-lit ground bounce (LIGHTING §1)', () => {
  it('adds nothing to an up-facing surface and π/2 × the radiance to a wall, π to the ground-facing side', () => {
    const base = ambientToSH({ sky: [0.3, 0.4, 0.5], horizon: [0.2, 0.2, 0.2], ground: [0.05, 0.05, 0.05] })
    const sh = addGroundSH(Float32Array.from(base), [1, 0.5, 0.25])
    const up0 = shIrradiance(base, 0, 1, 0)
    const up1 = shIrradiance(sh, 0, 1, 0)
    for (let c = 0; c < 3; c++) expect(up1[c]).toBeCloseTo(up0[c]!, 6)
    const wall0 = shIrradiance(base, 1, 0, 0)
    const wall1 = shIrradiance(sh, 1, 0, 0)
    expect(wall1[0] - wall0[0]).toBeCloseTo(Math.PI / 2, 5)
    expect(wall1[2] - wall0[2]).toBeCloseTo((Math.PI / 2) * 0.25, 5)
    const down0 = shIrradiance(base, 0, -1, 0)
    const down1 = shIrradiance(sh, 0, -1, 0)
    expect(down1[0] - down0[0]).toBeCloseTo(Math.PI, 5)
  })

  it('scales with the key light on level ground and vanishes with the sun below the horizon', () => {
    const cal = { sun: 2, env: 0.5 }
    const noon = groundBounceRadiance({ color: [1, 0.9, 0.8], intensity: 1, dirY: 1 }, cal)
    // E = 1 × 2 × 1 = 2 → radiance 2 × 0.15 / π, in SH units / env 0.5.
    expect(noon[0]).toBeCloseTo((2 * GROUND_BOUNCE) / Math.PI / 0.5, 6)
    expect(noon[2]).toBeCloseTo(noon[0] * 0.8, 6)
    const low = groundBounceRadiance({ color: [1, 1, 1], intensity: 1, dirY: 0.2 }, cal)
    expect(low[0]).toBeCloseTo(noon[0] * 0.2, 6)
    expect(groundBounceRadiance({ color: [1, 1, 1], intensity: 1, dirY: -0.3 }, cal)).toEqual([0, 0, 0])
  })
})

describe('eye adaptation (LIGHTING §2)', () => {
  it('leaves the calibration scenes alone and opens a dark view up, within the bounds', () => {
    expect(adaptTargetEV(ADAPT.keyDay, adaptKey(60))).toBeCloseTo(0, 6)
    const dark = adaptTargetEV(ADAPT.keyDay - 1.5, adaptKey(60))
    expect(dark).toBeCloseTo(ADAPT.strength * (1.5 - ADAPT.deadZoneEV), 6)
    // Small deviations (another preset, another view) are left alone.
    expect(adaptTargetEV(ADAPT.keyDay + ADAPT.deadZoneEV * 0.9, adaptKey(60))).toBeCloseTo(0, 6)
    expect(adaptTargetEV(ADAPT.keyDay - 1.5, adaptKey(60))).toBeCloseTo(-adaptTargetEV(ADAPT.keyDay + 1.5, adaptKey(60), 0, { ...ADAPT, maxDownEV: 9 }), 6)
    expect(adaptTargetEV(ADAPT.keyDay - 10, adaptKey(60))).toBe(ADAPT.maxUpEV)
    expect(adaptTargetEV(ADAPT.keyDay + 10, adaptKey(60))).toBe(-ADAPT.maxDownEV)
    expect(adaptTargetEV(NaN, adaptKey(60))).toBe(0)
  })

  it('keys night lower than day, lifts the night a little, and keeps a storm dark', () => {
    expect(adaptKey(60)).toBe(ADAPT.keyDay)
    expect(adaptKey(-20)).toBe(ADAPT.keyNight)
    expect(adaptKey(-1)).toBeGreaterThan(ADAPT.keyNight)
    expect(adaptKey(-1)).toBeLessThan(ADAPT.keyDay)
    expect(nightLift(60)).toBe(0)
    expect(nightLift(-20)).toBe(ADAPT.nightLiftEV)
    expect(storminess({ cloud: 0.2, rain: 0 })).toBe(0)
    expect(storminess({ cloud: 1, rain: 1 })).toBe(1)
    expect(storminess(null)).toBe(0)
    expect(adaptKey(60, 1)).toBeCloseTo(ADAPT.keyDay - ADAPT.stormKeyEV, 6)
  })

  it('opens up slowly and closes down fast', () => {
    const up = adaptStep(0, 1, 0.1)
    const down = adaptStep(0, -1, 0.1)
    expect(up).toBeGreaterThan(0)
    expect(-down).toBeGreaterThan(up)
    expect(adaptStep(0.4, 1, 100)).toBeCloseTo(1, 6)
    expect(adaptStep(0.4, 1, 0)).toBe(0.4)
  })

  it('is a post stage on Medium, High and Ultra, never on Low, and drops with its switch', () => {
    for (const p of ['medium', 'high', 'ultra'] as const) {
      const plan = planPost('pbr', RENDER_PRESETS[p], GPU)
      expect(plan.adapt).toBe(true)
      expect(plan.stages.indexOf('adapt')).toBe(plan.stages.indexOf('default') - 1)
      expect(plan.stages.indexOf('shafts')).toBeLessThan(plan.stages.indexOf('adapt'))
    }
    expect(planPost('pbr', RENDER_PRESETS.low, GPU).stages).toEqual([])
    expect(planPost('classic', RENDER_PRESETS.high, GPU).stages).toEqual([])
    const off = planPost('pbr', RENDER_PRESETS.high, GPU, { eyeAdaptation: false })
    expect(off.adapt).toBe(false)
    expect(off.stages).not.toContain('adapt')
  })
})

describe('soft shadows (LIGHTING §4)', () => {
  it('PCF on every preset (PCSS is wired but off, docs/LIGHTING.md §4), nothing on Low', () => {
    for (const p of ['medium', 'high', 'ultra'] as const) expect(csmSettings(RENDER_PRESETS[p].shadows!).soft).toBe(0)
    expect(csmSettings({ ...RENDER_PRESETS.high.shadows!, soft: 0.015 }).soft).toBe(0.015)
    expect(RENDER_PRESETS.low.shadows).toBeNull()
    expect(RENDER_PRESETS.low.eyeAdaptation).toBeFalsy()
  })

  it('every switch is on by default', () => {
    expect(Object.values(LIGHT_LOOK).every(v => v === true)).toBe(true)
  })
})

describe('lantern glow light pick (LIGHTING §3)', () => {
  let scene: Scene | null = null
  afterEach(() => {
    scene?.getEngine().dispose()
    scene = null
  })
  const slots = (): GlowLight[] => Array.from({ length: 3 }, () => ({ x: 0, y: 0, z: 0, range: 0, r: 0, g: 0, b: 0, score: 0 }))

  it('takes only lit night lamps and town lanterns near the eye, strongest first, at most the slots', () => {
    scene = new Scene(new NullEngine())
    const add = (name: string, x: number, intensity: number, range = 10) => {
      const l = new PointLight(name, new Vector3(x, 2, 0), scene!)
      l.intensity = intensity
      l.range = range
      return l
    }
    add('nl:light0', 5, 1)
    add('nl:light1', 10, 1)
    add('town:lantern0', 3, 2)
    add('nl:light2', 40, 1)
    add('nl:dark', 2, 0)
    add('fx:hitlight0', 1, 50)
    add('nl:far', GLOW_MAX_M + 20, 100)
    const out = slots()
    const n = pickGlowLights(scene, { x: 0, y: 2, z: 0 }, out)
    expect(n).toBe(3)
    expect(out.map(g => g.x)).toEqual([3, 5, 10])
    expect(out[0]!.r).toBeCloseTo(2, 6)
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score)
  })
})

// ---- lighting pass 2 ------------------------------------------------------------------------------------------------

describe('pass 2: atmosphere (LIGHTING §3)', () => {
  it('haze all day, a denser low mist in the morning, the retail fog at strength 0', async () => {
    const { atmosphereLook, atmosphereWeights, ATMOSPHERE } = await import('../src/render/atmosphere.ts')
    const noon = atmosphereLook(60, 0.5)
    expect(noon.density).toBeCloseTo(ATMOSPHERE.day.density, 6)
    expect(noon.start).toBeLessThan(1)
    const morning = atmosphereLook(5, 0.28)
    expect(morning.density).toBeGreaterThan(noon.density)
    expect(morning.falloffM).toBeLessThan(noon.falloffM)
    expect(atmosphereLook(5, 0.75).falloffM).toBeGreaterThan(morning.falloffM)
    expect(atmosphereLook(60, 0.5, 0)).toEqual({ density: 1, start: 1, falloffM: 80 })
    for (const [e, t] of [[60, 0.5], [5, 0.3], [5, 0.7], [-20, 0.9]]) {
      const w = atmosphereWeights(e!, t!)
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    }
  })
})

describe('pass 2: the cinematic grade (LIGHTING §5)', () => {
  it('skin turns towards G/R ≈ 0.75–0.85 at noon, the red lacquer keeps its hue, no lavender at dusk or night', async () => {
    const { GRADE_TIME, GRADE_TIME_V1, gradeColor, skinWeight } = await import('../src/render/grade.ts')
    const skin = [0.75, 0.5, 0.44]
    const day = gradeColor([...skin], GRADE_TIME.day)
    const old = gradeColor([...skin], GRADE_TIME_V1.day)
    expect(day[1]! / day[0]!).toBeGreaterThan(old[1]! / old[0]! + 0.05)
    expect(day[1]! / day[0]!).toBeGreaterThan(0.7)
    expect(day[1]! / day[0]!).toBeLessThan(0.9)
    expect(skinWeight([0.6, 0.12, 0.1])).toBe(0)
    const red = gradeColor([0.6, 0.12, 0.1], GRADE_TIME.day)
    expect(red[1]! / red[0]!).toBeLessThan(0.2)
    for (const k of ['dusk', 'night'] as const) {
      const lav = gradeColor([0.42, 0.36, 0.46], GRADE_TIME[k])
      // Lavender (R ≈ B > G) turns blue: blue clearly above red.
      expect(lav[2]! - lav[0]!).toBeGreaterThan(0.06)
    }
  })

  it('the filmic S keeps black and white and steepens the mids', async () => {
    const { filmicS } = await import('../src/render/grade.ts')
    expect(filmicS(0, 0.4)).toBe(0)
    expect(filmicS(1, 0.4)).toBe(1)
    expect(filmicS(0.2, 0.4)).toBeLessThan(0.2)
    expect(filmicS(0.8, 0.4)).toBeGreaterThan(0.8)
  })
})

describe('pass 2: WebGL2 shadows and Medium SSAO (LIGHTING §4, §6)', () => {
  it('caps the cascades at 1024² on WebGL2 only', async () => {
    const { WEBGL2_SHADOW_MAP_MAX } = await import('../src/render/shadows.ts')
    expect(csmSettings(RENDER_PRESETS.high.shadows!, { webgl: true }).mapSize).toBe(WEBGL2_SHADOW_MAP_MAX)
    expect(csmSettings(RENDER_PRESETS.high.shadows!).mapSize).toBe(2048)
    expect(csmSettings(RENDER_PRESETS.medium.shadows!, { webgl: true }).mapSize).toBe(1024)
  })

  it('an optional SSAO is dropped where it would stop FSR; Medium ships none (its CPU cost)', () => {
    expect(planPost('pbr', RENDER_PRESETS.medium, GPU).ssao).toBeNull()
    const q = { ...RENDER_PRESETS.medium, ssao: { halfRes: true, samples: 8, optional: true } }
    expect(planPost('pbr', q, GPU).ssao).not.toBeNull()
    const igpu = planPost('pbr', q, GPU, { renderScale: 0.75 })
    expect(igpu.ssao).toBeNull()
    expect(igpu.fsrScale).toBeGreaterThan(0)
  })
})
