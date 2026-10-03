/**
 * Wave 9B lane TX-R, the game side: `graphics.textures` ('auto' | 'retail' | 'remaster' | 1024 | 2048, "applies after
 * reload") and its effective tier per preset, the Low guard (without the new look every texture is retail and the
 * render block is Low's own object), the retired `graphics.remaster` switch as an alias for one wave, and the Options
 * row that replaced it.
 */
import { RENDER_PRESETS } from '@sro/world-render'
import { describe, expect, it } from 'vitest'
import { optionRows, type OptionsHost } from '../src/hud/options.ts'
import { PREVIEW_OFF_RENDER, TEXTURE_SETTINGS, defaultSettings, effectiveGraphics, normalizeSettings, patchedSettings, remasterSetsWanted, remasterTestSetsWanted } from '../src/settings.ts'
import { remasterWanted } from '../src/three/remaster-switch.ts'

const host: OptionsHost = {
  engine: 'WebGPU',
  keyHelp() {},
  toast() {},
  menu: { app: {} as OptionsHost['menu']['app'], close() {}, characterSelect() {}, logout() {} },
}

describe('graphics.textures', () => {
  it("defaults to 'auto'; anything else invalid normalises to it; every tier round-trips", () => {
    expect(defaultSettings().graphics.textures).toBe('auto')
    expect(TEXTURE_SETTINGS).toEqual(['auto', 'retail', 'remaster', 1024, 2048])
    for (const t of TEXTURE_SETTINGS) expect(normalizeSettings({ graphics: { textures: t } }).graphics.textures).toBe(t)
    expect(normalizeSettings({ graphics: { textures: 512 } }).graphics.textures).toBe('auto')
    expect(normalizeSettings({ graphics: { textures: '2048' } }).graphics.textures).toBe('auto')
  })

  it('the retired remaster switch is an alias: a save with it on and no tier starts on the remastered tier', () => {
    expect(normalizeSettings({ graphics: { remaster: true } }).graphics.textures).toBe('remaster')
    expect(normalizeSettings({ graphics: { remaster: true, textures: 2048 } }).graphics.textures).toBe(2048)
    expect(normalizeSettings({ graphics: { remaster: false } }).graphics.textures).toBe('auto')
  })

  it('without the new look every texture is retail and the render block is Low\'s own (the Low guard)', () => {
    const e = effectiveGraphics(normalizeSettings({ graphics: { preset: 'high', textures: 2048 } }), { rollout: 'preview' })
    expect(e.textureTier).toBe('retail')
    expect(e.renderQuality).toBe(PREVIEW_OFF_RENDER) // Low's block minus the night splats (W9F LG-2)
    const low = effectiveGraphics(normalizeSettings({ graphics: { preset: 'low', modern: true } }), { rollout: 'preview' })
    expect(low.textureTier).toBe('retail')
    expect(low.renderQuality).toBe(RENDER_PRESETS.low)
  })

  it("'auto' follows the preset; a pinned tier rides in QualitySettings.render.textures", () => {
    const tier = (preset: 'medium' | 'high' | 'ultra', textures: (typeof TEXTURE_SETTINGS)[number] = 'auto') =>
      effectiveGraphics(normalizeSettings({ graphics: { preset, modern: true, textures } }), { rollout: 'preview' })
    expect(tier('medium').textureTier).toBe('remaster')
    expect(tier('high').textureTier).toBe('2x')
    expect(tier('ultra').textureTier).toBe(2048)
    expect(tier('high').renderQuality).toBe(RENDER_PRESETS.high) // 'auto' leaves the preset block untouched
    expect(tier('high', 'retail').textureTier).toBe('retail')
    expect(tier('high', 'retail').renderQuality.textures).toBe('retail')
    expect(tier('medium', 1024).textureTier).toBe('2x')
    // A 16-varying adapter runs High as Medium: Medium's tier.
    const capped = effectiveGraphics(normalizeSettings({ graphics: { preset: 'high', modern: true } }), { rollout: 'preview', gpu: { maxInterStageShaderVariables: 16 } })
    expect(capped.textureTier).toBe('remaster')
  })

  it('the Options row: five tiers with the new look only, and its first change clears the retired switch', () => {
    const rows = optionRows(host, undefined, 'preview').graphics
    const row = rows.find(r => r.id === 'graphics.textures')
    expect(row?.kind).toBe('choice')
    if (row?.kind !== 'choice') return
    expect(row.choices.map(c => c.value)).toEqual(['auto', 'retail', 'remaster', 1024, 2048])
    expect(row.choices.every(c => c.label && !c.label.startsWith('options.'))).toBe(true)
    expect(row.when?.(defaultSettings())).toBe(false)
    expect(row.when?.(normalizeSettings({ graphics: { modern: true } }))).toBe(true)
    const next = patchedSettings(normalizeSettings({ graphics: { remaster: true } }), row.patch(1024))
    expect([next.graphics.textures, next.graphics.remaster]).toEqual([1024, false])
    expect(rows.some(r => r.id === 'graphics.remaster')).toBe(false)
  })
})

describe('?textures= (page-load A/B)', () => {
  it('parses the five tiers and ignores anything else; an explicit option wins over the settings', async () => {
    const { texturesFromSearch } = await import('../src/settings.ts')
    expect(texturesFromSearch('?textures=retail')).toBe('retail')
    expect(texturesFromSearch('?quality=high&textures=1024')).toBe(1024)
    expect(texturesFromSearch('?textures=2048')).toBe(2048)
    expect(texturesFromSearch('?textures=4096')).toBeNull()
    expect(texturesFromSearch('')).toBeNull()
    const s = normalizeSettings({ graphics: { preset: 'high', modern: true, textures: 2048 } })
    expect(effectiveGraphics(s, { rollout: 'preview', textures: 'retail' }).textureTier).toBe('retail')
    expect(effectiveGraphics(s, { rollout: 'preview', textures: null }).textureTier).toBe(2048)
  })
})

describe('the sro-remaster sets on a production page (the release: the approved Meshy sets ship)', () => {
  it('are looked for on every page, production included; ?remaster=0 leaves them out for the page load', () => {
    expect(remasterSetsWanted('')).toBe(true)
    expect(remasterSetsWanted('?remaster=1')).toBe(true)
    expect(remasterSetsWanted('?remaster=0')).toBe(false)
    expect(remasterSetsWanted('?remaster=off&x=1')).toBe(false)
    expect(remasterSetsWanted('?quality=high')).toBe(true)
  })

  it("the retired test switch's twins read them on the dev server or with ?remaster=1 only (I9A)", () => {
    expect(remasterTestSetsWanted(true, '')).toBe(true)
    expect(remasterTestSetsWanted(false, '')).toBe(false)
    expect(remasterTestSetsWanted(false, '?remaster=1')).toBe(true)
    expect(remasterTestSetsWanted(false, '?remaster=0')).toBe(false)
    expect(remasterTestSetsWanted(false, '?remaster=off&x=1')).toBe(false)
    // A production page with the retired switch saved on: no twins, no RemasterLighting.
    const saved = normalizeSettings({ graphics: { remaster: true } })
    expect(remasterWanted(saved, null, 'on', false)).toBe(false)
    expect(remasterWanted(saved, true, 'on', true)).toBe(true)
  })
})
