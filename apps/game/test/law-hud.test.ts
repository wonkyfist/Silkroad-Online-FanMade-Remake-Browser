/**
 * Siege of Jangan, layer 5 on the client (docs/SIEGE.md §9.3): the law's text helpers (banners, the WANTED label, the
 * Wanted panel's lines).
 */
import { describe, expect, it } from 'vitest'
import { fmtLeft, lawNoticeText, wantedLabel, wantedLines } from '../src/hud/law-hud.ts'
import { actionFailText } from '../src/hud/index.ts'

describe('law text', () => {
  it('the WANTED label and the countdown', () => {
    expect(wantedLabel(40_000)).toBe('WANTED · 40,000')
    expect(fmtLeft(2 * 3_600_000)).toBe('2:00:00')
    expect(fmtLeft(61_500)).toBe('1:02')
    expect(fmtLeft(-5)).toBe('0:00')
  })

  it('banners: a plant names no one; a breach names the breaker, the bounty, treason and accomplices', () => {
    expect(lawNoticeText({ t: 'lawNotice', event: 'plant', wall: 'W3' })).toBe('Someone is planting a Thunder Keg at the West wall (W3)!')
    expect(lawNoticeText({ t: 'lawNotice', event: 'wanted', wall: 'S2', name: 'Aki', bounty: 20_000 })).toBe('Aki has breached the South wall (S2)! A bounty of 20,000 gold is posted.')
    expect(lawNoticeText({ t: 'lawNotice', event: 'wanted', wall: 'S2', name: 'Aki', bounty: 40_000, treason: true, accomplices: ['Mei', 'Ryu'] })).toBe(
      'Treason! Aki has breached the South wall (S2) during the siege! A bounty of 40,000 gold is posted. Accomplices: Mei, Ryu.',
    )
    expect(lawNoticeText({ t: 'lawNotice', event: 'lapsed', name: 'Aki' })).toBe('The warrant for Aki has lapsed.')
    expect(lawNoticeText({ t: 'lawNotice', event: 'defused', wall: 'E1', name: 'Mei' })).toBe('Mei defused a Thunder Keg at the East wall (E1).')
  })

  it("the panel's lines and the keg_limit refusal", () => {
    expect(wantedLines({ bounty: 20_000, lapseMs: 3_600_000, offence: 2, role: 'accomplice', treason: true }, 3_599_000)).toEqual({
      head: 'Wanted',
      bounty: 'Bounty on your head: 20,000 gold',
      lapse: 'The warrant lapses in 59:59 online',
      note: 'Offence 2 · accomplice · treason',
      warn: 'Hunters can attack you anywhere but the Stockade',
    })
    expect(actionFailText('keg_limit')).toBe('Not another Thunder Keg yet.')
  })
})
