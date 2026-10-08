/**
 * Play the Boss, layer 5: big crowds (docs/PLAY_THE_BOSS.md §3.7). The formula against §3.7's table (max HP =
 * 47,898 × (clamp(N, 4, 40) / 4)^0.9; band waves 2/4 → 3/6 → 4/8 → 6/12), the step rules (up at once, down by at
 * most 10 % per 5 s step, the HP fraction kept, never killed by a step), and the hunt: N counts the distinct
 * non-associates with ≥ 200 damage to her in the last 60 s, the change reaches everyone who sees her as
 * `entityUpdate {hp, maxHp}`, the summon policy follows, scaling off keeps her at 47,898.
 */
import {
  PILOT_DEFAULTS,
  PILOT_SCALE_EVERY_MS,
  mergePilotPatch,
  pilotKeepFraction,
  pilotNextMaxHp,
  pilotScaleFactor,
  pilotScaledMaxHp,
  pilotScaledSummons,
  type PilotSettingsPatch,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { Player } from '../src/world.ts'
import { pilotHarness, type PilotHarness } from './pilot-harness.ts'

const S = PILOT_DEFAULTS.scaling
const BASE = 47_898
/** Her max HP in the hunt: 598,720 x hpMul 0.18 (content/uniques.json at level 25, docs/CLIMB.md §2.6; 47,898 before). */
const HER = 107_770
const BAND = { perWave: 2, maxAlive: 4 }

describe('the formula (§3.7)', () => {
  it("§3.7's table: 1–4 hunters 47,898; 10 → 109,300; 20 → 203,900; 40 and 60 → 380,500 (to the hundred)", () => {
    const hp = (n: number) => pilotScaledMaxHp(BASE, pilotScaleFactor(n, S))
    for (const n of [0, 1, 2, 3, 4]) expect(hp(n)).toBe(BASE)
    expect(Math.round(hp(10) / 100) * 100).toBe(109_300)
    expect(Math.round(hp(20) / 100) * 100).toBe(203_900)
    expect(Math.round(hp(40) / 100) * 100).toBe(380_500)
    expect(hp(60)).toBe(hp(40))
    expect(hp(10)).toBe(Math.round(BASE * 2.5 ** 0.9))
    expect(pilotScaleFactor(10, S)).toBeCloseTo(2.28, 2)
    expect(pilotScaleFactor(20, S)).toBeCloseTo(4.26, 2)
    expect(pilotScaleFactor(40, S)).toBeCloseTo(7.94, 2)
  })

  it('band waves: 2 / 4 → 3 / 6 → 4 / 8 → 6 / 12, never past 6 a wave; the factor 1 keeps the content', () => {
    const w = (n: number) => pilotScaledSummons(BAND, pilotScaleFactor(n, S))
    expect(w(4)).toEqual({ perWave: 2, maxAlive: 4 })
    expect(w(10)).toEqual({ perWave: 3, maxAlive: 6 })
    expect(w(20)).toEqual({ perWave: 4, maxAlive: 8 })
    expect(w(40)).toEqual({ perWave: 6, maxAlive: 12 })
    expect(pilotScaledSummons(BAND, 100)).toEqual({ perWave: 6, maxAlive: 12 })
  })

  it('the settings: scaling off = 1; the base, the cap and the exponent are numbers', () => {
    expect(pilotScaleFactor(40, { ...S, on: false })).toBe(1)
    expect(pilotScaleFactor(100, { ...S, capHunters: 100 })).toBeCloseTo(25 ** 0.9, 6)
    expect(pilotScaleFactor(8, { ...S, baseHunters: 8 })).toBe(1)
    expect(pilotScaleFactor(16, { ...S, baseHunters: 8, exponent: 1 })).toBe(2)
  })

  it('a step: up at once, down by at most 10 %; the HP fraction is kept, full stays full, alive stays alive', () => {
    expect(pilotNextMaxHp(BASE, 109_262)).toBe(109_262)
    expect(pilotNextMaxHp(109_262, BASE)).toBe(Math.round(109_262 * 0.9))
    expect(pilotNextMaxHp(50_000, BASE)).toBe(BASE)
    expect(pilotKeepFraction(23_949, BASE, 109_262)).toBe(54_631)
    expect(pilotKeepFraction(BASE, BASE, 109_262)).toBe(109_262)
    expect(pilotKeepFraction(1, 380_467, BASE)).toBe(1)
    expect(pilotKeepFraction(0, BASE, 109_262)).toBe(0)
  })
})

let H: PilotHarness | null = null
afterEach(() => {
  H?.cleanup()
  H = null
})

function setup(patch: PilotSettingsPatch = {}) {
  H = pilotHarness({ file: (f) => void (f.uniques[0].pilot!.defaults = mergePilotPatch(f.uniques[0].pilot!.defaults, patch)) })
  const s = H
  const pc = s.player(150, 150, 'Pixi')
  expect(s.gm('Pixi').ok).toBe(true)
  const offer = s.last(pc.inbox, 'pilotOffer')!
  s.req(pc.p, { t: 'pilotAnswer', event: offer.event, accept: true })
  const m = s.her()!
  const hunters = Array.from({ length: 12 }, (_, i) => s.player(m.pos[0] + 3 + (i % 4), m.pos[2] + 2 + Math.floor(i / 4), `Hunter${String.fromCharCode(65 + i)}`))
  const hit = (p: Player, d: number) => s.g.dealHits(p, m, [{ outcome: 'hit', damage: d, hp: 0 }], {}, s.h.now)
  /** To the next scaling step. */
  const step = () => s.tick(PILOT_SCALE_EVERY_MS)
  return { ...s, pc, m, hunters, hit, step }
}

describe('the hunt (§3.7)', () => {
  it('10 hunters with ≥ 200 damage: max HP 245,835 at the next step, HP fraction kept, everyone sees it; the summons follow', () => {
    const s = setup()
    expect(s.m.maxHp).toBe(HER)
    // 10 real hunters, one who scratched her (150), one that hit only a summon (not her).
    for (const h of s.hunters.slice(0, 10)) s.hit(h.p, 250)
    s.hit(s.hunters[10].p, 150)
    const before = s.m.hp / s.m.maxHp
    s.step()
    expect(s.m.maxHp).toBe(pilotScaledMaxHp(HER, pilotScaleFactor(10, S)))
    expect(s.m.maxHp).toBe(245_835)
    expect(s.m.hp / s.m.maxHp).toBeCloseTo(before, 4)
    const upd = s.last(s.hunters[11].inbox, 'entityUpdate')!
    expect(upd).toMatchObject({ id: s.m.id, maxHp: 245_835, hp: Math.round(s.m.hp) })
    // The pilot (her viewer) sees it too.
    expect(s.h.all(s.pc.inbox, 'entityUpdate').some((u) => u.id === s.m.id && u.maxHp === 245_835)).toBe(true)
    expect(s.g.uniques!.summonPolicy(s.m)).toMatchObject({ perWave: 3, maxAlive: 6 })
    expect(s.pilot.event!.scale).toMatchObject({ hunters: 10, peakHunters: 10, peakMaxHp: 245_835 })
    expect(s.gm('status').message).toMatch(/max HP 245835 \(10 hunters in the last 60 s\)/)
  })

  it("a hunter's damage leaves the window after 60 s; then she falls by at most 10 % a step, back to 107,770", () => {
    const s = setup()
    for (const h of s.hunters.slice(0, 10)) s.hit(h.p, 250)
    s.step()
    expect(s.m.maxHp).toBe(245_835)
    // N stays 10 until those hits are older than the window.
    s.tick(55_000)
    expect(s.m.maxHp).toBe(245_835)
    s.tick(10_000)
    const max: number[] = []
    for (let i = 0; i < 12; i++) {
      max.push(s.m.maxHp)
      s.step()
    }
    for (let i = 1; i < max.length; i++) expect(max[i]).toBeGreaterThanOrEqual(Math.round(max[i - 1] * 0.9))
    expect(max.some((v) => v < 245_835 && v > HER)).toBe(true)
    expect(s.m.maxHp).toBe(HER)
    expect(s.g.uniques!.summonPolicy(s.m)).toMatchObject({ perWave: 2, maxAlive: 4 })
    expect(s.m.hp).toBeGreaterThan(0)
  })

  it("associates (the pilot's party) are not counted toward N", () => {
    H = pilotHarness()
    const s = H
    const pc = s.player(150, 150, 'Pixi')
    const friends = Array.from({ length: 8 }, (_, i) => s.player(140 + i, 150, `Friend${String.fromCharCode(65 + i)}`))
    // A party holds at most a few members: invite four, the rest stay strangers.
    for (const f of friends.slice(0, 4)) {
      s.req(pc.p, { t: 'partyInvite', target: f.p.id })
      s.req(f.p, { t: 'partyRespond', inviter: pc.p.id, accept: true })
    }
    expect(s.gm('Pixi').ok).toBe(true)
    s.req(pc.p, { t: 'pilotAnswer', event: s.last(pc.inbox, 'pilotOffer')!.event, accept: true })
    const m = s.her()!
    for (const f of friends) s.g.dealHits(f.p, m, [{ outcome: 'hit', damage: 300, hp: 0 }], {}, s.h.now)
    s.tick(PILOT_SCALE_EVERY_MS)
    const partners = friends.filter((f) => s.g.party.sameParty(pc.p, f.p)).length
    expect(s.pilot.event!.scale!.hunters).toBe(8 - partners)
    expect(partners).toBeGreaterThan(0)
    expect(m.maxHp).toBe(pilotScaledMaxHp(HER, pilotScaleFactor(8 - partners, PILOT_DEFAULTS.scaling)))
  })

  it('scaling off: she stays at 107,770 whatever the crowd; a step never kills her', () => {
    const s = setup({ scaling: { on: false } })
    for (const h of s.hunters) s.hit(h.p, 400)
    s.step()
    expect(s.m.maxHp).toBe(HER)
    expect(s.g.uniques!.summonPolicy(s.m)).toMatchObject({ perWave: 2, maxAlive: 4 })
  })

  it('outside a hunt (an attach session, or no event) she is never scaled', () => {
    H = pilotHarness()
    const s = H
    const pc = s.player(150, 150, 'Pixi')
    const m = s.spawn()
    expect(s.gm('attach', 'Pixi').ok).toBe(true)
    for (let i = 0; i < 8; i++) s.g.dealHits(s.player(m.pos[0] + 3, m.pos[2] + i, `Att${String.fromCharCode(65 + i)}`).p, m, [{ outcome: 'hit', damage: 300, hp: 0 }], {}, s.h.now)
    s.tick(PILOT_SCALE_EVERY_MS * 2)
    expect(m.maxHp).toBe(HER)
    expect(s.g.uniques!.summonPolicy(m)).toMatchObject({ perWave: 2, maxAlive: 4 })
    void pc
  })
})
