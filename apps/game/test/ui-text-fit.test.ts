import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '../src/i18n/en.ts'
import { t, type StringKey } from '../src/i18n/index.ts'
import type { UiManifest } from '../src/ui/art.ts'
import { budgetWidth, CHAR_PX, fitsSkin, fitWidth, LABEL_PAD } from '../src/ui/kit/measure.ts'
import { BUTTONS, CONTROLS, skinKeys, TABS } from '../src/ui/kit/skins.ts'
import { TOOLTIP_STYLES } from '../src/ui/kit/tooltip.ts'

/**
 * The i18n budget (docs/UI.md §8): at a conservative 6.6 px per character of the 12-px basic font, every string
 * shown in a fixed-width retail skin either fits it or takes the auto-grow path (the control widens; its ends keep
 * their native size). Nothing is ever clipped by fixed art.
 */

const grows = (skinW: number, label: string) => fitWidth(skinW, budgetWidth(label)) >= budgetWidth(label) + 2 * LABEL_PAD

describe('i18n budget (6.6 px per character)', () => {
  it('the budget is the one the spec states', () => {
    expect(CHAR_PX).toBe(6.6)
    // com_button 76 − 16 = 60 px → 9 characters fit.
    expect(fitsSkin(BUTTONS.std.w, budgetWidth('x'.repeat(9)))).toBe(true)
    expect(fitsSkin(BUTTONS.std.w, budgetWidth('x'.repeat(10)))).toBe(false)
  })

  it('standard buttons: fit, or the auto-grow path widens them', () => {
    const labels: StringKey[] = ['kit.ok', 'kit.cancel', 'kit.yes', 'kit.no', 'hud.dialog.cancel', 'hud.drop.confirm', 'options.default', 'options.close', 'shop.buy', 'shop.sell', 'storage.deposit', 'party.invite']
    for (const key of labels) {
      const text = t(key)
      expect(fitsSkin(BUTTONS.std.w, budgetWidth(text)) || grows(BUTTONS.std.w, text), `${key}: ${text}`).toBe(true)
      expect(fitWidth(BUTTONS.std.w, budgetWidth(text)), key).toBeGreaterThanOrEqual(Math.min(BUTTONS.std.w, budgetWidth(text) + 16))
    }
  })

  it('System window rows (sys_button 152 − 16 px) hold 20 characters', () => {
    const rows: StringKey[] = ['menu.options', 'menu.keyHelp', 'menu.sound', 'menu.characterSelect', 'menu.logout', 'menu.resume']
    for (const key of rows) {
      const text = t(key)
      expect(text.length, `${key}: ${text}`).toBeLessThanOrEqual(20)
      expect(fitsSkin(BUTTONS.system.w, budgetWidth(text)), key).toBe(true)
    }
  })

  it('tab labels: com_long_tab (72 − 16 px) fits 8 characters, longer ones take the auto-grow path', () => {
    expect(fitsSkin(TABS.long.w, budgetWidth('Graphics'))).toBe(true)
    for (const key of ['options.tab.graphics', 'options.tab.interface', 'options.tab.controls', 'options.tab.audio'] as StringKey[]) {
      const text = t(key)
      expect(fitsSkin(TABS.long.w, budgetWidth(text)) || grows(TABS.long.w, text), `${key}: ${text}`).toBe(true)
    }
  })

  it('every kit string exists and is non-empty', () => {
    for (const [k, v] of Object.entries(en)) if (k.startsWith('kit.') || k.startsWith('gallery.')) expect(v.trim(), k).not.toBe('')
    expect(t('options.uiScale.auto')).toBe('Auto')
  })
})

describe('tooltip line classes map to styles', () => {
  it('today’s classes and the section classes all have a style', () => {
    for (const cls of ['title', 'title-plus', 'type', 'stat', 'req', 'bad', 'hint', 'desc', 'magic', 'sep', 'price', 'warn'] as const) {
      expect(TOOLTIP_STYLES[cls], cls).toMatch(/^kit-tt-/)
    }
  })
})

describe('baked text', () => {
  /** The only art with text allowed on screen: English, and matching (UI.md §0.8, §5.4; the hitcount tags, D2). */
  const ENGLISH_ART = /^(underbar\/ub_new_(menu|mainbar2|mainbar3)|skill\/(skl_button_(add|up)|skl_levelup|skl_mastery_levelup)|hitcount\/(critical|blocking|miss|resist))/

  it('no kit skin is an image with English text baked in', () => {
    for (const key of [...skinKeys(), ...Object.values(CONTROLS)]) expect(ENGLISH_ART.test(key), key).toBe(false)
  })

  const manifestPath = resolve(__dirname, '../../../work/out/ui/index.json')
  const manifest: UiManifest | null = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as UiManifest) : null
  it.skipIf(!manifest)('the manifest: kit skins carry no baked text, and englishText lists only the allowed English art', () => {
    const baked = manifest!.bakedText ?? {}
    for (const key of [...skinKeys(), ...Object.values(CONTROLS)]) expect(baked[key], key).toBeUndefined()
    for (const key of Object.keys(manifest!.englishText ?? {})) expect(ENGLISH_ART.test(key), key).toBe(true)
  })
})
