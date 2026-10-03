/** `uniqueNotice` (wave 11, docs/WAVE_PLAN7.md §3.1, docs/UNIQUES.md §3.3, §5.1): the server → client validator. */
import { describe, expect, it } from 'vitest'
import { UNIQUE_NOTICE_EVENTS, parseServerMessage, validateServerMessage, type ServerMessage } from '../src/index.ts'

const ok = (v: unknown): ServerMessage => {
  const r = validateServerMessage(v)
  if (!r.ok) throw new Error(r.error)
  return r.msg
}
const bad = (v: unknown): string => {
  const r = validateServerMessage(v)
  if (r.ok) throw new Error(`accepted ${JSON.stringify(v)}`)
  return r.error
}

describe('uniqueNotice', () => {
  it('lists the two events', () => {
    expect(UNIQUE_NOTICE_EVENTS).toEqual(['appeared', 'defeated'])
  })

  it('accepts an appear with and without an area (printed as is, trailing dot kept)', () => {
    const a = { t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', area: 'North-Tiger Mt.' }
    expect(ok(a)).toEqual(a)
    expect(ok({ t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl' })).toEqual({ t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl' })
  })

  it('accepts a defeat solo, by a party, and with nobody named', () => {
    const solo = { t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', area: 'South-Tiger Mt.', by: 'Mei', party: false }
    expect(ok(solo)).toEqual(solo)
    const party = { t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: 'Mei', party: true }
    expect(ok(party)).toEqual(party)
    expect(ok({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: 'Mei' })).toEqual({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: 'Mei' })
    expect(ok({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl' })).toMatchObject({ event: 'defeated' })
  })

  it('drops unknown extra keys', () => {
    expect(ok({ t: 'uniqueNotice', event: 'appeared', mob: 'M', name: 'N', camp: 5906 })).toEqual({ t: 'uniqueNotice', event: 'appeared', mob: 'M', name: 'N' })
  })

  it('rejects by or party on an appear', () => {
    expect(bad({ t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: 'Mei' })).toMatch(/defeated/)
    expect(bad({ t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', party: true })).toMatch(/defeated/)
  })

  it('rejects an empty mob or name, an unknown event, bad types', () => {
    bad({ t: 'uniqueNotice', event: 'appeared', mob: '', name: 'Tiger Girl' })
    bad({ t: 'uniqueNotice', event: 'appeared', name: 'Tiger Girl' })
    bad({ t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: '' })
    bad({ t: 'uniqueNotice', event: 'spawned', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl' })
    bad({ t: 'uniqueNotice', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl' })
    bad({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: 'Mei', party: 'yes' })
    bad({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: 'Mei', party: 1 })
    bad({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: '' })
    bad({ t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', area: 7 })
    bad({ t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'x'.repeat(65) })
  })

  it('parses from a text frame', () => {
    const r = parseServerMessage(JSON.stringify({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', by: 'Mei', party: true }))
    expect(r.ok).toBe(true)
  })
})
