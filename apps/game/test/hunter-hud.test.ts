/**
 * Siege of Jangan, layer 6 on the client (docs/SIEGE.md §8.2-§8.5, §9.3): the Hunter badge and ranks, the Stockade
 * panel's lines, the capture banners, the refusals; the stockade's props (a fence round the rectangle with the gate's
 * opening, the rock pile at the chores' spot); the planter's own keg offers no Defuse prompt (the layer-5 gap).
 */
import { existsSync } from 'node:fs'
import { STOCKADE, inStockade } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { actionFailText } from '../src/hud/index.ts'
import { captureText, hunterLabel, hunterRankName, jailLines } from '../src/hud/law-hud.ts'
import { kegInReach } from '../src/world/siege/model.ts'
import { stockadeProps } from '../src/world/siege/stockade.ts'

describe('Hunter and jail text', () => {
  it('ranks and the badge', () => {
    expect([0, 1, 2, 3, 4, 5].map(hunterRankName)).toEqual(['Recruit', 'Tracker', 'Bloodhound', 'Manhunter', 'Bounty Sergeant', 'Bounty Captain'])
    expect(hunterLabel(2)).toBe('BOUNTY HUNTER · Bloodhound')
  })

  it("the Stockade panel's lines: time left, offence and clock, chores", () => {
    const j = { leftMs: 0, sentenceMs: 7_200_000, offence: 2, chores: 3, choresLeft: 27, clock: 'real' as const }
    expect(jailLines(j, 6_453_000, 1)).toEqual({
      head: 'Garrison Stockade',
      left: '1:47:33 left',
      note: 'Offence 2 · the clock runs offline too',
      chores: 'Rocks broken: 3 (−3 min)',
    })
    expect(jailLines({ ...j, clock: 'online', chores: 30, choresLeft: 0 }, 60_000, 1)).toMatchObject({ note: 'Offence 2 · the clock runs while you are online', chores: 'Rocks broken: 30 (the most that counts)' })
  })

  it('capture banners for the captor, the pair rule and the prisoner; the refusals', () => {
    expect(captureText({ t: 'lawCapture', name: 'Aki', bounty: 40_000, gold: 30_000, sentenceMs: 14_400_000 })).toBe('You caught Aki! The garrison pays you 30,000 gold of the 40,000 bounty.')
    expect(captureText({ t: 'lawCapture', name: 'Aki', bounty: 40_000, gold: 0, sentenceMs: 14_400_000, pair: true, rule: 'pair', uncounted: true })).toMatch(/again within 7 days: no bounty and no capture/)
    expect(captureText({ t: 'lawCapture', name: 'Aki', bounty: 40_000, gold: 0, sentenceMs: 1, rule: 'lookout', uncounted: true })).toMatch(/stood by while their keg burned/)
    expect(captureText({ t: 'lawCapture', name: 'Aki', bounty: 40_000, gold: 10_000, sentenceMs: 1, rule: 'repeat' })).toBe('You caught Aki! The garrison pays you 10,000 gold of the 40,000 bounty. (Aki was caught several times this week: the garrison pays less.)')
    expect(captureText({ t: 'lawCapture', name: 'Aki', bounty: 40_000, gold: 0, sentenceMs: 7_200_000, prisoner: true, captors: ['Mei', 'Ryu'] })).toBe('Caught by Mei, Ryu. The garrison takes you to the Stockade for 2:00:00.')
    expect(actionFailText('jailed')).toBe('Not while you are locked in the Garrison Stockade.')
    expect(actionFailText('not_hunter')).toBe('Only Bounty Hunters on duty may do that.')
  })
})

describe("the stockade's props", () => {
  it('fence pieces run round the rectangle, leaving the gate open; the rocks lie at the pile, inside', () => {
    const props = stockadeProps()
    const fence = props.filter((p) => p.glb.includes('sfence'))
    expect(fence.length).toBeGreaterThanOrEqual(12)
    for (const f of fence) {
      const onEdge = Math.abs(f.x - STOCKADE.x0) < 0.01 || Math.abs(f.x - STOCKADE.x1) < 0.01 || Math.abs(f.z - STOCKADE.z0) < 0.01 || Math.abs(f.z - STOCKADE.z1) < 0.01
      expect(onEdge, JSON.stringify(f)).toBe(true)
    }
    // nothing closes the gate: no south piece's half-length reaches the opening's middle
    const south = fence.filter((f) => Math.abs(f.z - STOCKADE.z1) < 0.01)
    for (const f of south) expect(Math.abs(f.x - STOCKADE.gate.x) - (4.4 * (f.scale ?? 1))).toBeGreaterThan(1)
    const rocks = props.filter((p) => p.glb.includes('rock'))
    expect(rocks.length).toBeGreaterThan(3)
    for (const r of rocks) {
      expect(inStockade(r.x, r.z)).toBe(true)
      expect(Math.hypot(r.x - STOCKADE.pile.x, r.z - STOCKADE.pile.z)).toBeLessThan(3)
    }
  })

  // a model the export no longer places is not served (the drowned Western China side took w_cd_rock_s_03 with it)
  const EXPORT = new URL('../../../work/out-opt/world/jangan-fields/', import.meta.url)
  it.skipIf(!existsSync(new URL('manifest.json', EXPORT)))('every stockade model is in the export', () => {
    const missing = [...new Set(stockadeProps().map((p) => p.glb))].filter((g) => !existsSync(new URL(g, EXPORT)))
    expect(missing).toEqual([])
  })
})

describe('the Defuse prompt (layer-5 gap)', () => {
  it("skips a keg that is the player's own or a friend's (`mine`)", () => {
    const keg = (id: number, x: number, mine?: boolean) => ({ id, seg: 'W3', x, y: 0, z: 0, fuseEndsAt: 0, defuse: null, ...(mine ? { mine } : {}) })
    expect(kegInReach([keg(1, 0, true)], 0, 0, 3)).toBeNull()
    expect(kegInReach([keg(1, 0, true), keg(2, 2)], 0, 0, 3)?.id).toBe(2)
    expect(kegInReach([keg(1, 0)], 0, 0, 3)?.id).toBe(1)
  })
})
