import { describe, expect, it } from 'vitest'
import { weaponLabel } from '../src/content/catalog.ts'
import { en } from '../src/i18n/en.ts'
import { gameText, setGameText, t } from '../src/i18n/index.ts'
import { Art, type UiManifest } from '../src/ui/art.ts'

describe('i18n', () => {
  it('has no empty strings and fills placeholders', () => {
    for (const [k, v] of Object.entries(en)) expect(v.trim(), k).not.toBe('')
    expect(t('select.level', { level: 7 })).toBe('Level 7')
    expect(t('login.badPassword', { min: 6, max: 32 })).toBe('Password: 6-32 characters')
    // A missing variable stays visible instead of vanishing.
    expect(t('select.level')).toBe('Level {level}')
    expect(t('select.level', {})).toBe('Level {level}')
  })

  it('reads game text by id, with the UI table as fallback', () => {
    setGameText({})
    expect(weaponLabel('glaive')).toBe('Glaive')
    expect(gameText('UIO_NEWCHAR_CTL_CHINESE', 'fallback')).toBe('fallback')
    expect(setGameText({ UIO_NEWCHAR_STT_TBLADE: 'Pole Glaive', UIO_NEWCHAR_CTL_CHINESE: 'Chinese', EMPTY: '  ' })).toBe(2)
    expect(weaponLabel('glaive')).toBe('Pole Glaive')
    expect(gameText('UIO_NEWCHAR_CTL_CHINESE', 'x')).toBe('Chinese')
    expect(setGameText([{ id: 'A', text: 'a' }, { key: 'B', en: 'b' }])).toBe(2)
    expect(gameText('B', '')).toBe('b')
    setGameText({})
  })
})

describe('art text policy', () => {
  it('never reports images with baked-in text as available', () => {
    const img = { file: 'ui/x.png', width: 4, height: 4, content: [0, 0, 4, 4] as [number, number, number, number] }
    const manifest: UiManifest = {
      version: 1,
      images: { 'outer/logo': img, 'outer/login_window': img, 'loading/loading_zangan': img },
      music: {},
      bakedText: { 'outer/logo': 'Vietnamese logo', 'loading/loading_zangan': 'logo' },
    }
    const art = new Art(manifest)
    expect(art.has('outer/logo')).toBe(false)
    expect(art.has('outer/login_window')).toBe(true)
    expect(art.has('loading/loading_zangan')).toBe(false)
    expect(art.hasCropped('loading/loading_zangan')).toBe(true)
    expect(art.hasCropped('outer/nothing')).toBe(false)
  })
})
