/**
 * Retail damage-number sprites (hud/hitcount.ts; docs/EFFECTS.md §3.1, docs/WAVE_PLAN2.md D2): digit keys per
 * palette, the shadow under the white digits, the "Critical" tag above, "miss" / "Block" alone, heals left to DOM
 * text, half-size layout, the victim kinds from screens/world.ts hitKind, and that every key is exported.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CombatHit } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { floaterText } from '../src/hud/effects.ts'
import { HITCOUNT_SCALE, hitcountKeys, hitPalette, hitSprites } from '../src/hud/hitcount.ts'
import { hitKind } from '../src/screens/world.ts'

const keys = (kind: Parameters<typeof hitSprites>[1], amount = 0, palette?: Parameters<typeof hitSprites>[2]) =>
  hitSprites(amount, kind, palette)!.sprites.map(s => s.key.replace('hitcount/', ''))

describe('hitcount layout', () => {
  it('draws your hits as white digits over their shadows, in order', () => {
    const l = hitSprites(1234, 'hit')!
    expect(l.palette).toBe('dealt')
    expect(keys('hit', 1234)).toEqual([
      'hitcount_1_shadow', 'hitcount_2_shadow', 'hitcount_3_shadow', 'hitcount_4_shadow',
      'hitcount_1', 'hitcount_2', 'hitcount_3', 'hitcount_4',
    ])
    const digits = l.sprites.slice(4)
    for (let i = 1; i < digits.length; i++) {
      const step = digits[i]!.x - digits[i - 1]!.x
      expect(step).toBeGreaterThan(8)
      expect(step).toBeLessThan(18)
    }
    expect(digits[0]!.w).toBe(36 * HITCOUNT_SCALE)
    expect(digits[0]!.h).toBe(60 * HITCOUNT_SCALE)
    expect(l.height).toBe(30)
    expect(l.sprites.every(s => s.x >= 0 && s.y >= 0 && s.x + s.w <= l.width + 1e-9)).toBe(true)
  })

  it('draws hits on you in the red enemy digits (outline baked in, no shadow sprite)', () => {
    expect(hitPalette('taken')).toBe('taken')
    expect(keys('taken', 507)).toEqual(['hitcount_enemy_5', 'hitcount_enemy_0', 'hitcount_enemy_7'])
  })

  it("draws another player's hits in the player digits", () => {
    expect(keys('hit', 90, 'other')).toEqual(['hitcount_player_9', 'hitcount_player_0'])
  })

  it('puts "Critical" above the digits, centred', () => {
    const l = hitSprites(88, 'crit')!
    const tag = l.sprites.find(s => s.key === 'hitcount/critical')!
    const shadow = l.sprites.find(s => s.key === 'hitcount/critical_shadow')!
    const digit = l.sprites.find(s => s.key === 'hitcount/hitcount_8')!
    expect(shadow).toBeTruthy()
    expect(l.sprites.indexOf(shadow)).toBeLessThan(l.sprites.indexOf(tag))
    expect(tag.y).toBe(0)
    expect(digit.y).toBeGreaterThan(tag.y)
    expect(tag.w).toBe(96 * HITCOUNT_SCALE)
    const digits = l.sprites.filter(s => /hitcount_\d$/.test(s.key))
    const mid = (Math.min(...digits.map(d => d.x)) + Math.max(...digits.map(d => d.x + d.w))) / 2
    expect(Math.abs(tag.x + tag.w / 2 - mid)).toBeLessThan(4)
    expect(keys('critTaken', 12)).toEqual(['hitcount_enemy_1', 'hitcount_enemy_2', 'critical_enemy'])
  })

  it('draws miss and block as their tags alone, white for yours and red for those on you', () => {
    expect(keys('miss')).toEqual(['miss_player'])
    expect(keys('missTaken')).toEqual(['miss_enemy'])
    expect(keys('block')).toEqual(['blocking_shadow', 'blocking'])
    expect(keys('blockTaken')).toEqual(['blocking_enemy'])
    const miss = hitSprites(0, 'miss')!
    expect([miss.width, miss.height]).toEqual([30, 14])
  })

  it('leaves heals to DOM text', () => {
    expect(hitSprites(50, 'heal')).toBeNull()
    expect(floaterText(50, 'heal')).toBe('+50')
    expect(floaterText(0, 'missTaken')).toBe(floaterText(0, 'miss'))
    expect(floaterText(0, 'blockTaken')).toBe(floaterText(0, 'block'))
    expect(floaterText(1234, 'critTaken')).toBe('1,234')
  })

  it('draws a zero and clamps negatives', () => {
    expect(keys('hit', 0)).toEqual(['hitcount_0_shadow', 'hitcount_0'])
    expect(keys('taken', -5)).toEqual(['hitcount_enemy_0'])
  })
})

describe('hitKind victim art (screens/world.ts)', () => {
  const hit = (outcome: CombatHit['outcome']): CombatHit => ({ outcome, damage: 10, hp: 90 }) as CombatHit
  it('keeps the outcome of hits on you when asked, and the old kinds otherwise', () => {
    expect(hitKind(hit('crit'), true, true)).toBe('critTaken')
    expect(hitKind(hit('miss'), true, true)).toBe('missTaken')
    expect(hitKind(hit('block'), true, true)).toBe('blockTaken')
    expect(hitKind(hit('hit'), true, true)).toBe('taken')
    expect(hitKind(hit('crit'), false, true)).toBe('crit')
    expect(hitKind(hit('miss'), false, true)).toBe('miss')
    expect(hitKind(hit('crit'), true)).toBe('taken')
    expect(hitKind(hit('miss'), true)).toBe('miss')
  })
})

describe('the export has every sprite', () => {
  const manifest = join(import.meta.dirname, '../../../work/out/ui/index.json')
  it.runIf(existsSync(manifest))('lists every hitcount key in /out/ui/index.json', () => {
    const images = (JSON.parse(readFileSync(manifest, 'utf8')) as { images: Record<string, unknown> }).images
    const missing = hitcountKeys().filter(k => !images[k])
    expect(missing).toEqual([])
  })
})
