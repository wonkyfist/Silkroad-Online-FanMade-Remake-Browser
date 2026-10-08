/**
 * PLAZA-RAIN: the Jangan plaza got no rain look because the shelter map drew the region batch's tree groups with every
 * tier (LOD1 + LOD2, never band-collapsed), a solid roof ~40 m over the town. The height pass now collapses the tiers
 * the band hides (SH_BAND), the plaza paving is stone, and object floors pool from Medium up, joints first.
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_CLASS_OVERRIDES, MATERIAL_CLASS_PARAMS, resolveClass } from '../src/pbr/classes.ts'
import { PUDDLE_JOINT_GAIN, objectPuddle, surfaceFragmentCode } from '../src/pbr/surface-plugin.ts'
import { SHELTER_SHADERS } from '../src/weather/shelter.ts'

describe('shelter map: banded tree groups (SH_BAND)', () => {
  it('collapses hidden tiers to the root in both languages', () => {
    for (const vs of [SHELTER_SHADERS.vertexWGSL, SHELTER_SHADERS.vertexGLSL]) {
      expect(vs).toContain('#ifdef SH_BAND')
      expect(vs).toContain('sroPivot')
      expect(vs).toContain('sroTreeBand')
      expect(vs).toMatch(/shBand != shTier/)
    }
  })
})

describe('plaza paving class', () => {
  it('cj_jang_gate07 is stone (puddles) whatever the built set says, any slash or case', () => {
    expect(BUILTIN_CLASS_OVERRIDES.get('prim/mtrl/bldg/china/jangan01/cj_jang_gate07.ddj')).toBe('stone')
    expect(resolveClass('Prim/Mtrl/Bldg/China/Jangan01/CJ_JANG_GATE07.ddj'.split('/').join('\\'), {}, null, 'default')).toBe('stone')
    expect(MATERIAL_CLASS_PARAMS.stone.puddle).toBeGreaterThan(0)
    // the override file still wins, other sets keep their class
    expect(resolveClass('prim/mtrl/bldg/china/jangan01/cj_jang_gate07.ddj', {}, new Map([['prim/mtrl/bldg/china/jangan01/cj_jang_gate07.ddj', 'wood']]), 'default')).toBe('wood')
    expect(resolveClass('prim/mtrl/bldg/china/jangan01/cj_jang_gate01.ddj', {}, null, 'default')).toBe('default')
  })
})

describe('object puddle mask', () => {
  it('fills the joints (low AO) before the open stone, grows with the level, dries to nothing', () => {
    const noise = 0.4
    expect(objectPuddle(noise, 1, 0.9)).toBeLessThan(0.05)
    expect(objectPuddle(noise, 0.4, 0.9)).toBeGreaterThan(0.95)
    expect(objectPuddle(noise, 0.4, 0)).toBe(0)
    expect(objectPuddle(noise, 0.6, 0.3)).toBeLessThan(objectPuddle(noise, 0.6, 0.9))
    expect(PUDDLE_JOINT_GAIN).toBeGreaterThan(0)
  })
  it('the shader adds the AO term on the table path in both languages', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = Object.values(surfaceFragmentCode(lang)).join('\n')
      expect(code).toContain(`(1.0 - sroTAo) * ${PUDDLE_JOINT_GAIN.toFixed(2)};`)
    }
  })
})
