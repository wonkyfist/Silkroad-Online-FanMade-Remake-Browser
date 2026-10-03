/**
 * W5-G grass and plants in the client settings: graphics.scatter ('auto' follows the preset), qualityFor, and the
 * Options → Graphics row.
 */
import { QUALITY_PRESETS } from '@sro/world-render'
import { describe, expect, it } from 'vitest'
import { optionRows, visibleRows, type OptionsHost } from '../src/hud/options.ts'
import { t } from '../src/i18n/index.ts'
import { SettingsStore, defaultSettings, normalizeSettings, qualityFor } from '../src/settings.ts'

describe('graphics.scatter (W5-G)', () => {
  it("defaults to 'auto', which follows the graphics preset", () => {
    expect(defaultSettings().graphics.scatter).toBe('auto')
    for (const preset of ['low', 'medium', 'high'] as const) {
      const s = normalizeSettings({ graphics: { preset } })
      expect(qualityFor(s).scatter).toBe(QUALITY_PRESETS[preset].scatter)
      expect(QUALITY_PRESETS[preset].scatter).toBe(preset)
    }
  })

  it('a fixed level wins over the preset; junk falls back to auto', () => {
    expect(qualityFor(normalizeSettings({ graphics: { preset: 'high', scatter: 'off' } })).scatter).toBe('off')
    expect(qualityFor(normalizeSettings({ graphics: { preset: 'low', scatter: 'high' } })).scatter).toBe('high')
    expect(normalizeSettings({ graphics: { scatter: 'ultra' } }).graphics.scatter).toBe('auto')
    expect(normalizeSettings({ graphics: { scatter: 3 } }).graphics.scatter).toBe('auto')
  })

  it('has one Options → Graphics row whose choices write the setting', () => {
    const host: OptionsHost = {
      engine: 'WebGL2',
      keyHelp() {},
      toast() {},
      menu: { app: {} as OptionsHost['menu']['app'], close() {}, characterSelect() {}, logout() {} },
    }
    const rows = visibleRows(optionRows(host).graphics).filter(r => r.id === 'graphics.scatter')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    if (row.kind !== 'choice') throw new Error('expected a choice row')
    expect(row.choices.map(c => c.value)).toEqual(['auto', 'off', 'low', 'medium', 'high'])
    // Wave 10 (GRASS_LIFE Q2, W10-G): relabelled "Grass", the values unchanged.
    expect(t(row.label)).toBe('Grass')
    for (const c of row.choices) expect(c.label).not.toMatch(/^options\./)
    const store = new SettingsStore(null)
    for (const c of row.choices) {
      store.set(row.patch(c.value))
      expect(row.get(store.get())).toBe(c.value)
    }
  })
})
