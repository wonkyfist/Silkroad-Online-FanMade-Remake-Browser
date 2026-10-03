/**
 * F-11 (H11-NL-5, docs/UNIQUES.md §3.3): her roar for the players near where she appears. The server marks their
 * `uniqueNotice` with `roar: true` (apps/server uniques.ts, announce.roarRadiusM); the client plays the roar file once,
 * at once (not with the queued banner). The wire check keeps `roar` to the appear notice.
 */
import { validateServerMessage } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { UNIQUE_ROARS, showUniqueNotice, type UniqueNoticeMessage } from '../src/hud/unique-notice.ts'
import type { NoticeBanner } from '../src/ui/notice.ts'

const appeared: UniqueNoticeMessage = { t: 'uniqueNotice', event: 'appeared', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', area: 'North-Tiger Mt.' }

function run(msg: UniqueNoticeMessage) {
  const files: string[] = []
  const cues: string[] = []
  const notices = { show: () => {} } as unknown as NoticeBanner
  showUniqueNotice(msg, { notices, audio: { ui: c => void cues.push(c), playFile: f => void files.push(f) } }, () => true)
  return files
}

describe('the unique roar (H11-NL-5)', () => {
  it('plays her roar once for a notice marked roar, and not for the rest', () => {
    expect(run({ ...appeared, roar: true })).toEqual([UNIQUE_ROARS.MOB_CH_TIGERWOMAN])
    expect(run(appeared)).toEqual([])
    expect(run({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl' })).toEqual([])
  })

  it('the wire check takes roar on an appearance only', () => {
    expect(validateServerMessage({ ...appeared, roar: true })).toMatchObject({ ok: true, msg: { roar: true } })
    expect(validateServerMessage({ t: 'uniqueNotice', event: 'defeated', mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', roar: true })).toMatchObject({ ok: false })
  })
})
