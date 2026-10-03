import { describe, expect, it } from 'vitest'
import { en } from '../src/i18n/en.ts'
import { t, type StringKey } from '../src/i18n/index.ts'
import { budgetWidth, fitWidth, LABEL_PAD } from '../src/ui/kit/measure.ts'
import { fitFontSize, OUTER_BUTTON, SEX_PLATE, sliderStepAt, sliderThumbX, WARNING_BUTTON } from '../src/screens/outer-ui.ts'

/**
 * Lane UI-O (docs/UI.md §4.7): the outer screens' fixed art never clips a label (A9: "Femal(e)"), and the retail
 * slider of character creation maps pointer x to the five steps and back.
 */

describe('outer screens: labels fit their retail art', () => {
  it('outer buttons fit or take the auto-grow path', () => {
    const labels: StringKey[] = [
      'login.connect',
      'login.register',
      'login.create',
      'login.back',
      'login.reload',
      'servers.select',
      'servers.cancel',
      'select.start',
      'select.create',
      'select.delete',
      'select.back',
      'create.ok',
      'create.back',
    ]
    for (const key of labels) {
      const w = budgetWidth(t(key))
      expect(fitWidth(OUTER_BUTTON.w, w), key).toBeGreaterThanOrEqual(w + 2 * LABEL_PAD)
    }
    for (const key of ['select.deleteConfirm', 'select.deleteCancel', 'create.confirm', 'create.cancel'] as StringKey[]) {
      const w = budgetWidth(t(key))
      expect(fitWidth(WARNING_BUTTON.w, w), key).toBeGreaterThanOrEqual(w + 2 * LABEL_PAD)
    }
  })

  it('"Male" and "Female" fit the plate beside the gem (the size shrinks before anything clips)', () => {
    for (const key of ['create.male', 'create.female'] as StringKey[]) {
      const text = t(key)
      expect(budgetWidth(text), text).toBeLessThanOrEqual(SEX_PLATE.textW - 2)
      expect(fitFontSize(text, SEX_PLATE.textW - 2)).toBe(12)
    }
    // A long translation falls to the smallest size instead of overflowing the plate's text window.
    expect(fitFontSize('Weiblich (female)', SEX_PLATE.textW - 2)).toBe(10)
  })

  it('the lane strings exist', () => {
    expect(en['outer.select.levelLabel']).toBeTruthy()
  })
})

describe('outer screens: the character-creation slider', () => {
  // pscharactercreatechina.txt Slider section: the 120-px control at x 88, thumb 16 px from 20 to 104.
  const X0 = 108
  const RANGE = 84
  it('places the thumb of each of the five steps 21 px apart', () => {
    expect([0, 1, 2, 3, 4].map(v => sliderThumbX(v, 5, X0, RANGE))).toEqual([108, 129, 150, 171, 192])
    expect(sliderThumbX(-3, 5, X0, RANGE)).toBe(108)
    expect(sliderThumbX(9, 5, X0, RANGE)).toBe(192)
  })

  it('maps a pointer x back to the step under it, clamped to the track', () => {
    for (let v = 0; v < 5; v++) expect(sliderStepAt(sliderThumbX(v, 5, X0, RANGE) + 8, 5, X0, RANGE, 16)).toBe(v)
    expect(sliderStepAt(0, 5, X0, RANGE, 16)).toBe(0)
    expect(sliderStepAt(500, 5, X0, RANGE, 16)).toBe(4)
    expect(sliderStepAt(150, 1, X0, RANGE, 16)).toBe(0)
  })
})
