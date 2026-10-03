import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyOuterSize, LEGACY_INSET } from '../src/hud/window.ts'
import { normalizeSettings, defaultSettings } from '../src/settings.ts'
import { optionRows, type OptionsHost } from '../src/hud/options.ts'
import { Art, type UiManifest } from '../src/ui/art.ts'
import * as kit from '../src/ui/kit/index.ts'
import { cursorValue, CURSOR_KINDS, CURSOR_OVERLAYS } from '../src/ui/kit/cursor.ts'
import { countResult, initialCount, promptResult } from '../src/ui/kit/dialog.ts'
import { clipFor, fraction, gaugeText, segmentFills } from '../src/ui/kit/gauge.ts'
import { parseAmount, stepAmount } from '../src/ui/kit/input.ts'
import { visibleRange } from '../src/ui/kit/list.ts'
import { mainTabRect, nextSlot } from '../src/ui/kit/main-window.ts'
import { fitWidth } from '../src/ui/kit/measure.ts'
import { nineSliceGeometry, tileSpan } from '../src/ui/kit/nine.ts'
import { artRendering, autoScale, clampWindow, isUiScaleMode, openPosition, uiScale, UI_SCALE_MODES, UI_STEPS } from '../src/ui/kit/scale.ts'
import { scrollForThumb, thumbGeometry } from '../src/ui/kit/scroll.ts'
import { BUTTONS, CONTROLS, FRAMES, GAUGES, nineKey, resolveFrame, skinKeys, TABS, type FrameSkin } from '../src/ui/kit/skins.ts'
import { sliderRatio, sliderValue } from '../src/ui/kit/slider.ts'
import { countDigits, initials, mergeSigns, signOf, SlotGrid } from '../src/ui/kit/slot.ts'
import { KIT_CSS, TOKENS } from '../src/ui/kit/tokens.ts'
import { placeTooltip } from '../src/ui/kit/tooltip.ts'

describe('UI scale (docs/UI.md §4.1)', () => {
  it('Auto follows the table', () => {
    expect(autoScale(1024, 768)).toBe(1)
    expect(autoScale(1280, 720)).toBe(1)
    expect(autoScale(1366, 768)).toBe(1)
    expect(autoScale(1920, 1080)).toBe(1.25)
    expect(autoScale(2560, 1440)).toBe(1.5)
    expect(autoScale(3840, 2160)).toBe(2.5)
    expect(autoScale(900, 600)).toBe(0.75)
    expect(autoScale(844, 390)).toBe(0.75)
  })

  it('is never below 1 on a desktop-sized viewport, and always a step there', () => {
    for (let w = 1024; w <= 4000; w += 37) {
      for (let h = 700; h <= 2400; h += 53) {
        const s = autoScale(w, h)
        expect(s, `${w}x${h}`).toBeGreaterThanOrEqual(1)
        expect(UI_STEPS as readonly number[]).toContain(s)
        // Auto keeps at least 1280×800 native px of room once it is above 1.
        if (s > 1) expect(Math.min(w / s, h / s * 1.6)).toBeGreaterThanOrEqual(1280 - 1e-6)
      }
    }
  })

  it('uiScale: Auto, fixed steps, and a fixed step lowered until the UI fits', () => {
    expect(uiScale('auto', 1920, 1080)).toBe(1.25)
    expect(uiScale(undefined, 1024, 768)).toBe(1)
    expect(uiScale(1, 1920, 1080)).toBe(1)
    expect(uiScale(1.25, 1024, 768)).toBe(1.25)
    expect(uiScale(2, 2560, 1440)).toBe(2)
    // 1080 / 2 = 540 < 560 native px of height: one step down.
    expect(uiScale(2, 1920, 1080)).toBe(1.5)
    expect(uiScale(3, 1280, 720)).toBe(1.25)
    expect(uiScale(3, 3840, 2160)).toBe(3)
    // Small viewports never grow past Auto.
    expect(uiScale(2, 900, 600)).toBe(0.75)
    expect(isUiScaleMode('auto')).toBe(true)
    expect(isUiScaleMode(1.5)).toBe(true)
    expect(isUiScaleMode(1.1)).toBe(false)
    expect(UI_SCALE_MODES).toEqual(['auto', 1, 1.25, 1.5, 2, 2.5, 3])
  })

  it('draws art pixelated only when every art pixel is whole device pixels', () => {
    expect(artRendering(1.5, 1)).toBe('auto')
    expect(artRendering(1, 2)).toBe('pixelated')
    expect(artRendering(1, 1)).toBe('pixelated')
    expect(artRendering(2, 1)).toBe('pixelated')
    expect(artRendering(1.25, 2)).toBe('auto')
    expect(artRendering(1.25, 0.8)).toBe('pixelated')
    expect(artRendering(0.75, 1)).toBe('auto')
    expect(artRendering(1, Number.NaN)).toBe('pixelated')
  })

  it('the setting: ui.scaleMode defaults to auto and rejects non-steps', () => {
    expect(defaultSettings().ui.scaleMode).toBe('auto')
    expect(normalizeSettings({ ui: { scaleMode: 1.25 } }).ui.scaleMode).toBe(1.25)
    expect(normalizeSettings({ ui: { scaleMode: 1.1 } }).ui.scaleMode).toBe('auto')
    expect(normalizeSettings({ ui: { scaleMode: '2' } }).ui.scaleMode).toBe('auto')
  })

  it('Options → Interface → UI scale is a select of Auto and the steps, writing ui.scaleMode', () => {
    const host: OptionsHost = { engine: 'x', keyHelp() {}, toast() {}, menu: { app: {} as OptionsHost['menu']['app'], close() {}, characterSelect() {}, logout() {} } }
    const row = optionRows(host).interface.find(r => r.id === 'ui.scale')
    expect(row?.kind).toBe('choice')
    if (row?.kind !== 'choice') return
    expect(row.style).toBe('select')
    expect(row.choices.map(c => c.value)).toEqual([...UI_SCALE_MODES])
    expect(row.choices[0]!.label).toBe('Auto')
    expect(row.choices[2]!.label).toBe('125%')
    expect(row.patch(2)).toEqual({ ui: { scaleMode: 2 } })
  })
})

describe('window placement (native px in the zoomed layer)', () => {
  it('keeps 60 px of a window and its title on screen', () => {
    expect(clampWindow(-500, -20, 300, 1024, 768)).toEqual([-240, 0])
    expect(clampWindow(2000, 2000, 300, 1024, 768)).toEqual([964, 738])
    expect(clampWindow(100.4, 50.6, 300, 1024, 768)).toEqual([100, 51])
  })

  it('cascades from the last opened window by 24 px, and wraps', () => {
    expect(openPosition([300, 200], [1024, 768], { prev: [100, 100] })).toEqual([124, 124])
    const wrapped = openPosition([300, 200], [1024, 768], { prev: [700, 560] })
    expect(wrapped[0]).toBeLessThan(700)
    expect(wrapped[1]).toBeLessThan(560)
    // No window open: the `at` fraction of the free space, else centred a little high.
    expect(openPosition([300, 200], [1024, 768], { at: [0, 0] })).toEqual([0, 0])
    expect(openPosition([300, 200], [1024, 768], { at: [1, 1] })).toEqual([724, 568])
    expect(openPosition([300, 200], [1024, 768])).toEqual([362, 227])
  })

  it('HudWindow keeps each old body size inside the mframe chrome', () => {
    const [top, right, bottom, left] = LEGACY_INSET
    const [w, h] = legacyOuterSize(320, 480)
    expect(w - left - right).toBe(320)
    expect(h - top - bottom).toBe(480 - 28)
  })
})

describe('skins and nine-slice frames', () => {
  const MFRAME = {
    left_up: [40, 68],
    mid_up: [128, 68],
    right_up: [40, 68],
    left_side: [40, 128],
    right_side: [40, 128],
    left_down: [40, 48],
    mid_down: [128, 48],
    right_down: [40, 48],
  } as const

  it('mframe pieces → insets 68/40/48/40', () => {
    const g = nineSliceGeometry(MFRAME)
    expect([g.top, g.right, g.bottom, g.left]).toEqual([68, 40, 48, 40])
    expect(g.midW).toBe(128)
    expect(g.midH).toBe(128)
    expect(g.width).toBe(208)
    expect(g.height).toBe(244)
    expect(tileSpan(24, 16)).toBe(48)
    expect(tileSpan(128, 96)).toBe(256)
    expect(tileSpan(0, 12)).toBe(12)
  })

  it('every skin key is a well-formed manifest key', () => {
    for (const key of skinKeys()) {
      expect(key, key).toMatch(/^[a-z0-9_]+(\/[a-z0-9_]+)+$/)
      expect(key, key).not.toMatch(/\.(png|ddj)$/)
    }
    for (const f of Object.values(FRAMES) as FrameSkin[]) {
      expect(f.prefix.endsWith('_'), f.prefix).toBe(true)
      expect(f.inset).toHaveLength(4)
      for (const p of f.fallback ?? []) expect(p.endsWith('_'), p).toBe(true)
    }
    for (const b of Object.values(BUTTONS)) expect(b.slice * 2).toBeLessThan(b.w)
    for (const k of Object.values(CONTROLS)) expect(k, k).toMatch(/^[a-z0-9_]+(\/[a-z0-9_]+)+$/)
    expect(nineKey('frame/mframe_wnd_')).toBe('frame/mframe_wnd_9')
    expect(TABS.flex.caps).toBe(12)
  })

  it('a missing family falls back, and no art at all gives none', () => {
    const img = { file: 'ui/x.png', width: 16, height: 16, content: [0, 0, 16, 16] as [number, number, number, number] }
    const pieces = (prefix: string) => Object.fromEntries(['left_up', 'mid_up', 'right_up', 'left_side', 'right_side', 'left_down', 'mid_down', 'right_down'].map(p => [prefix + p, img]))
    const old = new Art({ version: 1, images: pieces('frame/frameg01_wnd_'), music: {} })
    expect(resolveFrame(old, FRAMES.main)).toBe('frame/frameg01_wnd_')
    const sheet = new Art({ version: 1, images: { 'frame/mframe_wnd_9': { ...img, nine: { top: 68, right: 40, bottom: 48, left: 40 } } }, music: {} })
    expect(resolveFrame(sheet, FRAMES.main)).toBe('frame/mframe_wnd_')
    expect(sheet.nine('frame/mframe_wnd_9')).toEqual({ top: 68, right: 40, bottom: 48, left: 40 })
    expect(resolveFrame(new Art(null), FRAMES.main)).toBeUndefined()
    expect(old.hasAny('nope', 'frame/frameg01_wnd_left_up')).toBe(true)
    expect(old.hasAny('nope')).toBe(false)
  })

  // The kit export (UI-X) has run when the manifest carries the main-window sheet; until then this is skipped.
  const manifestPath = resolve(__dirname, '../../../work/out/ui/index.json')
  const manifest: UiManifest | null = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as UiManifest) : null
  const exported = !!manifest?.images['frame/mframe_wnd_9']
  it.skipIf(!exported)('every FRAMES / BUTTONS / TABS / GAUGES key is exported (work/out/ui/index.json)', () => {
    const art = new Art(manifest)
    const missing: string[] = []
    for (const f of Object.values(FRAMES) as FrameSkin[]) {
      if (f.fill && !art.has(f.fill)) missing.push(f.fill)
      if (!art.has(nineKey(f.prefix)) || !art.nine(nineKey(f.prefix))) missing.push(nineKey(f.prefix))
    }
    for (const b of Object.values(BUTTONS)) for (const s of ['', '_focus', '_press']) if (!art.has(b.key + s)) missing.push(b.key + s)
    for (const k of skinKeys()) if (!art.has(k) && !missing.includes(k)) missing.push(k)
    for (const g of Object.values(GAUGES)) if (!art.has(g) && !missing.includes(g)) missing.push(g)
    expect(missing).toEqual([])
  })
})

describe('controls (pure parts)', () => {
  it('gauges clip by value and fill the EXP band segment by segment', () => {
    expect(fraction(50, 100)).toBe(0.5)
    expect(fraction(5, 0)).toBe(0)
    expect(fraction(150, 100)).toBe(1)
    expect(fraction(Number.NaN, 100)).toBe(0)
    expect(clipFor(0.25)).toBe('inset(0 75.000% 0 0)')
    expect(segmentFills(0, 10)).toEqual(Array(10).fill(0))
    expect(segmentFills(0.05, 10)).toEqual([0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    const f = segmentFills(0.1234, 10)
    expect(f[0]).toBe(1)
    expect(f[1]).toBeCloseTo(0.234)
    expect(f.slice(2).every(x => x === 0)).toBe(true)
    expect(segmentFills(0.9999, 10)[9]).toBeCloseTo(0.999)
    expect(segmentFills(1, 10)).toEqual(Array(10).fill(1))
    expect(gaugeText(1234, 2000, 'value')).toBe('1,234 / 2,000')
    expect(gaugeText(1234, 10000, 'percent')).toBe('12.34%')
  })

  it('slot signs (M9): one sign, rare over magic over +N, and decorators merge', () => {
    expect(signOf({})).toBeNull()
    expect(signOf({ plus: 3 })).toBe('plus')
    expect(signOf({ plus: 3, magic: true })).toBe('magic')
    expect(signOf({ plus: 3, magic: true, rare: true })).toBe('rare')
    expect(signOf({ plus: 0 })).toBeNull()
    // Built-ins first, then a decorator (e.g. the durability lane's).
    expect(mergeSigns({ plus: 2 }, { durability: 'low' }, undefined, { durability: undefined })).toEqual({ plus: 2, durability: 'low' })
    expect(mergeSigns({ durability: 'low' }, { durability: 'broken' })).toEqual({ durability: 'broken' })
    expect(countDigits(1)).toBe('')
    expect(countDigits(250)).toBe('250')
    expect(initials('Hp Potion 01')).toBe('HP')
    expect(initials('01')).toBe('?')
    expect(SlotGrid.indexAt(40, 80, 4, 8)).toBe(9)
    expect(SlotGrid.indexAt(150, 0, 4, 8)).toBe(-1)
  })

  it('scroll bar, list window, slider, amounts', () => {
    expect(thumbGeometry(0, 100, 200, 150).hidden).toBe(true)
    const g = thumbGeometry(300, 1000, 250, 200)
    expect(g).toEqual({ top: 60, size: 50, hidden: false })
    expect(thumbGeometry(0, 100_000, 100, 200).size).toBe(16)
    expect(scrollForThumb(75, 50, 200, 1000, 250)).toBe(375)
    expect(visibleRange(0, 240, 24, 1000)).toEqual([0, 14])
    expect(visibleRange(2400, 240, 24, 1000)).toEqual([96, 114])
    expect(visibleRange(0, 240, 24, 0)).toEqual([0, 0])
    expect(sliderValue(0.5, 0, 100, 5)).toBe(50)
    expect(sliderValue(0.52, 0, 100, 5)).toBe(50)
    expect(sliderValue(2, 0, 100, 5)).toBe(100)
    expect(sliderValue(0.5, 0.5, 2, 0.25)).toBe(1.25)
    expect(sliderRatio(75, 50, 100)).toBe(0.5)
    expect(parseAmount(' 1,200 ', 1, 5000)).toBe(1200)
    expect(parseAmount('12a', 1, 50)).toBeNull()
    expect(parseAmount('0', 1, 50)).toBeNull()
    expect(stepAmount(49, 5, 1, 50)).toBe(50)
    expect(stepAmount(Number.NaN, 1, 1, 50)).toBe(2)
  })

  it('message boxes (M13): count and prompt results', () => {
    expect(countResult('5', 10)).toBe(5)
    expect(countResult('11', 10)).toBeNull()
    expect(countResult('0', 10)).toBeNull()
    expect(countResult('', 10)).toBeNull()
    expect(countResult('3', 0)).toBeNull()
    expect(initialCount(250)).toBe(250)
    expect(initialCount(250, 400)).toBe(250)
    expect(initialCount(250, 0)).toBe(1)
    expect(promptResult('  My stall ', 24)).toBe('My stall')
    expect(promptResult('   ', 24)).toBeNull()
    expect(promptResult('   ', 24, true)).toBe('')
    expect(promptResult('x'.repeat(25), 24)).toBeNull()
    expect(typeof kit.MessageBox.confirm).toBe('function')
    expect(typeof kit.MessageBox.count).toBe('function')
    expect(typeof kit.MessageBox.prompt).toBe('function')
    expect(kit.MessageBox.isOpen()).toBe(false)
  })

  it('cursors (M12) include repair, all with the hand hotspot', () => {
    expect(CURSOR_KINDS).toEqual(['normal', 'attack', 'talk', 'pickup', 'repair'])
    for (const k of CURSOR_KINDS) if (k !== 'normal' && k !== 'repair') expect(CURSOR_OVERLAYS[k].length).toBeGreaterThan(0)
    // Repair is the drawn hammer glyph (no retail hammer art).
    expect(CURSOR_OVERLAYS.repair).toEqual([])
    expect(cursorValue('u.png')).toBe('url("u.png") 2 2, auto')
    expect(typeof kit.setCursor).toBe('function')
  })

  it('tooltips flip at the screen edges', () => {
    expect(placeTooltip(100, 100, 200, 120, 1024, 768)).toEqual([116, 116])
    expect(placeTooltip(900, 100, 200, 120, 1024, 768)).toEqual([688, 116])
    expect(placeTooltip(100, 700, 200, 120, 1024, 768)).toEqual([116, 568])
  })

  it('the Main window side strip: retail slots, then the first free one after the retail strip', () => {
    expect(mainTabRect(0)).toEqual([-36, 78, 28, 28])
    expect(mainTabRect(4)).toEqual([-36, 246, 28, 28])
    expect(nextSlot('inventory', [])).toBe(1)
    expect(nextSlot('quest', [0, 1])).toBe(5)
    // The retail slots of other tabs (Action 3, Apprenticeship 6, …) stay reserved (H7B UI7B-6).
    expect(nextSlot('guild', [0, 1, 2])).toBe(7)
    expect(nextSlot('guild', [0, 1, 2, 4, 5, 7])).toBe(8)
    expect(nextSlot('party', [4])).toBe(7)
  })

  it('buttons grow to their label, never below the skin', () => {
    expect(fitWidth(76, 30)).toBe(76)
    expect(fitWidth(76, 90)).toBe(106)
  })
})

describe('tokens and the kit API (M16)', () => {
  it('defines the retail colours once, incl. the guild name and the stall chat', () => {
    expect(TOKENS['--c-label']).toBe('#efdaa4')
    expect(TOKENS['--c-level']).toBe('#ffd953')
    expect(TOKENS['--c-chat-guild']).toBe('#ffba4d')
    expect(TOKENS['--c-chat-stall']).toBe('#c6b6ff')
    expect(TOKENS['--c-guild-name']).toBe('#8fd18f')
    for (const [k, v] of Object.entries(TOKENS)) expect(KIT_CSS).toContain(`${k}: ${v};`)
  })

  it('exports every control wave 8 builds on', () => {
    for (const name of ['Window', 'MainWindow', 'Section', 'Frame', 'TabBar', 'Gauge', 'Slot', 'SlotGrid', 'Tooltip', 'List', 'ScrollArea', 'TextInput', 'NumberInput', 'Checkbox', 'Radio', 'RadioGroup', 'Slider', 'Select', 'Notice'] as const) {
      expect(typeof kit[name], name).toBe('function')
    }
    for (const name of ['button', 'iconButton', 'Icon', 'Label', 'Value', 'Row', 'setCursor', 'ensureKitStyles', 'nineSlice', 'uiScale'] as const) expect(typeof kit[name], name).toBe('function')
  })
})
