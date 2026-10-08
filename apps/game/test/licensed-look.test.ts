import { FreeCamera, NullEngine, Scene, ShaderLanguage, Vector3 } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { licensedMaterialRole, SKIN_DIFFUSE_POINT, SKIN_F0_FACTOR, SKIN_SCATTER, SkinWrapPlugin } from '../src/three/licensed-materials.ts'
import { cameraAxes, FACE_MIN, faceFillDirection, faceKeyNeed, faceFloorIntensity, faceMinIntensity, selfKeyDirection } from '../src/world/features/self-key.ts'

describe('licensed look (CHARACTERS §16.1)', () => {
  it('sorts the pack materials into their shading roles', () => {
    expect(licensedMaterialRole('MAT_HEAD')).toBe('skin')
    expect(licensedMaterialRole('MAT_BODY')).toBe('skin')
    expect(licensedMaterialRole('MAT_EYES_L')).toBe('eye')
    expect(licensedMaterialRole('MAT_EYE_R')).toBe('eye')
    expect(licensedMaterialRole('MAT_LASHES')).toBe('lashes')
    expect(licensedMaterialRole('MAT_HAIR')).toBe('hair')
    expect(licensedMaterialRole('MAT_CLOTHES_sim')).toBe('cloth')
    // skin F0 0.028 from glTF's 0.04
    expect(0.04 * SKIN_F0_FACTOR).toBeCloseTo(0.028, 6)
  })

  it('aims the own key light from above the camera and to its right, towards the scene', () => {
    const d = selfKeyDirection(new Vector3(0, 0, 1), new Vector3(1, 0, 0))
    expect(d.length()).toBeCloseTo(1, 6)
    expect(d.z).toBeGreaterThan(0.6) // travels away from the camera
    expect(d.y).toBeLessThan(-0.2) // downwards: it comes from slightly above (§16.5: ≈ 20°)
    expect(d.y).toBeGreaterThan(-0.45)
    expect(d.x).toBeLessThan(-0.25) // leftwards: it comes from the camera's right
  })

  it("fills the face from the camera's other side, a little from below, and floors the key on the sky (§16.5)", () => {
    const f = faceFillDirection(new Vector3(0, 0, 1), new Vector3(1, 0, 0))
    expect(f.length()).toBeCloseTo(1, 6)
    expect(f.z).toBeGreaterThan(0.6)
    expect(f.x).toBeGreaterThan(0.4) // comes from the camera's left
    expect(f.y).toBeGreaterThan(0) // from below
    // the floor follows the sky: none at a black night, π·share·a by day
    expect(faceFloorIntensity(0, 1)).toBe(0)
    expect(faceFloorIntensity(0.5, 1, 0.8)).toBeCloseTo(Math.PI * 0.4, 6)
    // §16.6: the absolute minimum is display-referred: 6× the key at night's exposure (≈ 67) as at noon's (≈ 11)
    expect(faceMinIntensity(11, FACE_MIN.exposure) / faceMinIntensity(67, FACE_MIN.exposure)).toBeCloseTo(67 / 11, 6)
  })

  it('aims key and fill at the face in the right-handed world scene (§16.7: they lit the back of the head)', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const cam = new FreeCamera('c', new Vector3(0, 1.6, 5), scene)
    cam.setTarget(new Vector3(0, 1.6, 0))
    cam.computeWorldMatrix(true)
    const fwd = new Vector3(), right = new Vector3()
    cameraAxes(cam, true, fwd, right)
    const view = new Vector3(0, 0, -1)
    expect(Vector3.Dot(fwd, view)).toBeCloseTo(1, 5)
    // the light travels away from the camera, onto the face it looks at
    expect(Vector3.Dot(selfKeyDirection(fwd, right), view)).toBeGreaterThan(0.8)
    expect(Vector3.Dot(faceFillDirection(fwd, right), view)).toBeGreaterThan(0.6)
    // and comes from the camera's screen right (+x for a camera looking down −z with y up)
    expect(selfKeyDirection(fwd, right).x).toBeLessThan(-0.25)
    scene.dispose()
    engine.dispose()
  })

  it('counts the sun already on the face before topping it up to the minimum (§16.7)', () => {
    const view = new Vector3(0, 0, -1)
    // the noon sun from high behind the camera: 0.79 × 0.38 is on the face already
    expect(faceKeyNeed(0.45, 0.79, new Vector3(0.01, -0.925, -0.379), view)).toBeCloseTo(0.45 - 0.79 * 0.379, 2)
    // against the light (sun behind the head) or at night the key carries it all
    expect(faceKeyNeed(0.45, 0.79, new Vector3(0, -0.5, 0.866), view)).toBeCloseTo(0.45, 6)
    expect(faceKeyNeed(0.1, 5, new Vector3(0, 0, -1), view)).toBe(0)
  })

  it("wraps only the skin's diffuse, per channel, red furthest, GLSL and WGSL alike (§16.7)", () => {
    expect(SKIN_SCATTER[0]).toBeGreaterThan(SKIN_SCATTER[1])
    expect(SKIN_SCATTER[1]).toBeGreaterThan(SKIN_SCATTER[2])
    for (const lang of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
      const code = SkinWrapPlugin.prototype.getCustomCode.call({}, 'fragment', lang)!
      const [point, repl] = Object.entries(code)[0]!
      expect(point).toBe(SKIN_DIFFUSE_POINT)
      const re = new RegExp(point.slice(1), 'g')
      // Babylon 9.28 pbrDirectLightingFunctions: the diffuse return (the specular's ends in specTerm*…, untouched)
      const src = '#endif\nreturn diffuseTerm*info.attenuation*info.NdotL*lightColor;}\nvec3 specTerm=fresnel*distribution*smithVisibility;return specTerm*info.attenuation*info.NdotL*lightColor;}'
      const out = src.replace(re, repl)
      expect(out).toContain('info.NdotLUnclamped')
      expect(out).toContain(SKIN_SCATTER[0].toFixed(3))
      expect(out).toContain('return specTerm*info.attenuation*info.NdotL*lightColor;}')
      expect(out.includes('vec3f(')).toBe(lang === ShaderLanguage.WGSL)
    }
  })
})

describe('licensed face variant (CHARACTERS §16.3)', () => {
  it('offers only the variants the sidecar lists, next to the glb', async () => {
    const { licensedFaceOf, licensedFaceUrl } = await import('../src/three/licensed-char.ts')
    const side = { licensed: { gender: 'f', face: '16_04', faces: ['16_04', '27'] } }
    expect(licensedFaceOf('?newchar=1&ncface=27')).toBe('27')
    expect(licensedFaceOf('?ncface=../x')).toBeNull()
    expect(licensedFaceUrl('/out/char/licensed/waterbender/waterbender_f_01.glb', side, '27')).toBe('/out/char/licensed/waterbender/faces/f_27.jpg')
    expect(licensedFaceUrl('/x/a.glb', side, '16_04')).toBeNull() // the built-in one
    expect(licensedFaceUrl('/x/a.glb', side, '13_01')).toBeNull() // not built
  })
})
