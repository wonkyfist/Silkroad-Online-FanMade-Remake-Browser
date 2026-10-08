import { describe, expect, it } from 'vitest'
import { PILOT_BODIES, pilotCovers, pilotMeshShown, pilotPresetOf, sliderWeights } from '../src/three/pilot-char.ts'
import { pilotRootScale, pilotTrackKept } from '../src/three/pilot-clip.ts'

describe('pilot character (P1 stage 1)', () => {
  it('reads the flag and its options', () => {
    expect(pilotPresetOf('')).toBeNull()
    expect(pilotPresetOf('?newchar=0')).toBeNull()
    expect(pilotPresetOf('?newchar=1')).toEqual({ outfit: 'a5', hair: 'ponytail', body: PILOT_BODIES.average })
    expect(pilotPresetOf('?newchar=curvy&ncoutfit=base&nchair=bob')).toEqual({ outfit: 'base', hair: 'bob', body: PILOT_BODIES.curvy })
  })

  it('maps a 0–100 slider onto its morph pair', () => {
    expect(sliderWeights(50)).toEqual({ minus: 0, plus: 0 })
    expect(sliderWeights(0)).toEqual({ minus: 1, plus: 0 })
    expect(sliderWeights(100)).toEqual({ minus: 0, plus: 1 })
    expect(sliderWeights(75)).toEqual({ minus: 0, plus: 0.5 })
    expect(sliderWeights(-20)).toEqual({ minus: 1, plus: 0 })
  })

  it('shows the outfit, the uncovered regions and one hairstyle', () => {
    const covers = pilotCovers({ pilot: { outfits: { a5: { covers: ['under'] } } } }, 'a5')
    const p = pilotPresetOf('?newchar=1&nchair=bob')!
    expect(pilotMeshShown('pilot_body_under', p, covers)).toBe(false)
    expect(pilotMeshShown('pilot_body_skin', p, covers)).toBe(true)
    expect(pilotMeshShown('pilot_body_head', p, covers)).toBe(true)
    expect(pilotMeshShown('pilot_outfit_a5', p, covers)).toBe(true)
    expect(pilotMeshShown('pilot_hair_bob', p, covers)).toBe(true)
    expect(pilotMeshShown('pilot_hair_ponytail', p, covers)).toBe(false)
    const base = pilotPresetOf('?newchar=1&ncoutfit=base')!
    expect(pilotMeshShown('pilot_body_under', base, covers)).toBe(true)
    expect(pilotMeshShown('pilot_outfit_a5', base, covers)).toBe(false)
  })
})

describe('pilot clip tracks (§15.3)', () => {
  it('plays rotations everywhere, translation only on the root, never scale', () => {
    expect(pilotTrackKept('rotationQuaternion', 'Bip01 L UpperArm')).toBe(true)
    expect(pilotTrackKept('position', 'Bip01')).toBe(true)
    expect(pilotTrackKept('position', 'Bip01 L UpperArm')).toBe(false)
    expect(pilotTrackKept('translation', 'Bip01 Pelvis')).toBe(false)
    expect(pilotTrackKept('scaling', 'Bip01')).toBe(false)
    expect(pilotTrackKept('scale', 'Bip01 Head')).toBe(false)
  })

  it('reads the root scale from the sidecar', () => {
    expect(pilotRootScale(null)).toBe(1)
    expect(pilotRootScale({ pilot: { rootScale: 0.957 } })).toBe(0.957)
    expect(pilotRootScale({ pilot: { rootScale: 9 } })).toBe(1)
  })
})
