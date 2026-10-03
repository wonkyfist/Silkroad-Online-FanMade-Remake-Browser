import { CHARACTER_RULES } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { spExpFraction, spExpTooltip, spGained, spGainedText } from '../src/hud/player.ts'

describe('SP on the HUD (EXP bar SP-EXP gauge, "+1 SP", chat line)', () => {
  it('fills the SP-EXP gauge out of 400 and clamps it', () => {
    expect(CHARACTER_RULES.spExpPerSp).toBe(400)
    expect(spExpFraction(0, 400)).toBe(0)
    expect(spExpFraction(192, 400)).toBe(0.48)
    expect(spExpFraction(399, 400)).toBeCloseTo(0.9975)
    expect(spExpFraction(900, 400)).toBe(1)
    expect(spExpFraction(-5, 400)).toBe(0)
    expect(spExpFraction(10, 0)).toBe(0)
  })

  it('tooltip reads "SP EXP n / 400" with the skill points owned', () => {
    expect(spExpTooltip(192, 400, 0)).toBe('SP EXP 192 / 400\nSkill points: 0')
    expect(spExpTooltip(0, 400, 2530)).toBe('SP EXP 0 / 400\nSkill points: 2,530')
  })

  it('counts skill points gained, never on the first snapshot or when SP was spent', () => {
    expect(spGained(undefined, 12)).toBe(0)
    expect(spGained(0, 1)).toBe(1)
    expect(spGained(10, 260)).toBe(250)
    expect(spGained(12, 3)).toBe(0)
    expect(spGained(5, 5)).toBe(0)
  })

  it('chat line', () => {
    expect(spGainedText(1, 3)).toBe('You gained a skill point. Skill points: 3.')
    expect(spGainedText(250, 1250)).toBe('You gained 250 skill points. Skill points: 1,250.')
  })
})
