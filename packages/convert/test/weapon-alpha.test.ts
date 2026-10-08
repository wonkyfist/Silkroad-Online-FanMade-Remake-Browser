/** Weapons and shields: their partial texture alpha is a specular mask, so the converter exports them opaque. */
import { describe, expect, it } from 'vitest'
import { isWeaponPath } from '../src/gltf/convert.ts'

describe('weapon alpha', () => {
  it('knows a weapon or shield resource by its path', () => {
    expect(isWeaponPath('res/item/china/weapon/spear_03.bsr')).toBe(true)
    expect(isWeaponPath('res\\item\\europe\\shield\\shield_01.bsr')).toBe(true)
    expect(isWeaponPath('res/item/china/m_heavy/ba_01.bsr')).toBe(false)
    expect(isWeaponPath('res/char/china/chinaman_adventurer.bsr')).toBe(false)
  })
})
