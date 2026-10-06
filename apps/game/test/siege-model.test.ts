/**
 * Siege of Jangan, layer 4 on the client (docs/SIEGE.md §9.3, §9.5): the HUD's text and colours (phases, timers, the
 * meta line, the 33 pips in order around the town), the banners' text per notice, the keg in reach, the reward window's
 * lines; every i18n key the model asks for exists; the server's messages pass the client's validator.
 */
import { validateServerMessage, type SiegeRewardView, type SiegeView } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { en } from '../src/i18n/en.ts'
import { approachText, fmtClock, kegInReach, noticeText, pipLook, pipOrder, rewardLines, siegeLines, siegeMeta, wallText } from '../src/world/siege/model.ts'

const NOW = 1_000_000

describe('the siege HUD model', () => {
  it('clock text', () => {
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(-5)).toBe('0:00')
    expect(fmtClock(61_000)).toBe('1:01')
    expect(fmtClock(599_001)).toBe('10:00')
    expect(fmtClock(3_723_000)).toBe('1:02:03')
  })

  it('head and timer per phase', () => {
    const v = (o: Partial<SiegeView>): SiegeView => ({ id: 1, phase: 'warning', approaches: ['W', 'S'], ...o })
    expect(siegeLines(v({ nextAt: NOW + 4 * 60_000 + 30_000 }), NOW)).toEqual({ head: 'An army marches on Jangan', timer: 'The army arrives in 4:30' })
    expect(siegeLines(v({ phase: 'wave1', nextAt: NOW + 60_000 }), NOW)).toEqual({ head: 'Wave 1 of 3', timer: 'Next wave in 1:00' })
    expect(siegeLines(v({ phase: 'wave2', nextAt: NOW + 1000 }), NOW).head).toBe('Wave 2 of 3')
    expect(siegeLines(v({ phase: 'wave3', endsAt: NOW + 90_000 }), NOW)).toEqual({ head: 'The final assault', timer: '1:30 left' })
    expect(siegeLines(v({ phase: 'ended', outcome: 'won' }), NOW)).toEqual({ head: 'Jangan stands! The Bandit Warlord has fallen.', timer: null })
    expect(siegeLines(v({ phase: 'ended', outcome: 'lost_bell' }), NOW).head).toBe('The Town Bell has fallen.')
    expect(siegeMeta(v({ defenders: 12, foes: 40, breaches: 2 }))).toBe('12 defenders · 40 foes · 2 breaches')
    expect(siegeMeta(v({ phase: 'ended', defenders: 3, foes: 9 }))).toBe('3 defenders')
  })

  it('pips around the town clockwise from the north-west, coloured by stage', () => {
    const ids = ['W1', 'S1', 'N2', 'E1', 'N10', 'N1', 'S9', 'W7', 'E7']
    expect(pipOrder(ids)).toEqual(['N1', 'N2', 'N10', 'E1', 'E7', 'S9', 'S1', 'W7', 'W1'])
    expect(pipLook('intact', 100)).toBe('intact')
    expect(pipLook('cracked', 60)).toBe('cracked')
    expect(pipLook('cracked', 35)).toBe('deep')
    expect(pipLook('breached', -10)).toBe('breached')
    expect(pipLook('rubble', -50)).toBe('rubble')
  })

  it('banner text for every notice', () => {
    expect(approachText(['W', 'S'])).toBe('the west road and the south fields')
    expect(approachText(['N'])).toBe('the north fields')
    expect(wallText('W3')).toBe('the West wall (W3)')
    expect(noticeText({ t: 'siegeNotice', event: 'phase', phase: 'warning', approaches: ['E', 'N'] })).toBe('Scouts report an army marching on Jangan from the east road and the north fields!')
    expect(noticeText({ t: 'siegeNotice', event: 'phase', phase: 'wave3' })).toBe('The Bandit Warlord leads the final assault!')
    expect(noticeText({ t: 'siegeNotice', event: 'phase', phase: 'ended', outcome: 'lost_time' })).toBe('The Warlord withdrew with his plunder.')
    expect(noticeText({ t: 'siegeNotice', event: 'breach', wall: 'S4' })).toBe('The army broke through the South wall (S4)! Defend the Town Bell!')
    expect(noticeText({ t: 'siegeNotice', event: 'plant', wall: 'E2' })).toBe('A sapper has planted a keg at the East wall (E2)!')
    expect(noticeText({ t: 'siegeNotice', event: 'defused', wall: 'E2', name: 'Mei' })).toBe('Mei defused a keg at the East wall (E2).')
    expect(noticeText({ t: 'siegeNotice', event: 'blast', wall: 'N3' })).toBe('A keg blew at the North wall (N3)!')
  })

  it('the keg in reach: the nearest within the range', () => {
    const k = (id: number, x: number, z: number) => ({ id, seg: 'W3', x, y: 0, z, fuseEndsAt: 0, defuse: null })
    const list = [k(1, 0, 5), k(2, 0, 2), k(3, 1, 1)]
    expect(kegInReach(list, 0, 0, 2.8)?.id).toBe(3)
    expect(kegInReach(list, 50, 50, 2.8)).toBeNull()
  })

  it('the reward window: won with gold, Seals and the title; lost; too few points', () => {
    const r: SiegeRewardView = { event: 3, outcome: 'won', points: 412, rank: 1, of: 9, gold: 20_600, seals: 8, title: 'jangan_defender', top: [{ name: 'Aki', points: 412 }], parts: { damage: 352, defuse: 30, bell: 30 } }
    const honor = (c: string) => (c === 'jangan_defender' ? 'Defender of Jangan' : c)
    expect(rewardLines(r, honor)).toEqual({
      head: 'Victory!',
      lines: ['Your contribution: 412 points (rank 1 of 9)', 'Gold: 20,600', 'Siege Seals: 8', 'Title earned: Defender of Jangan'],
      parts: 'fighting 352 · kegs defused 30 · Bell repairs 30',
    })
    expect(rewardLines({ ...r, outcome: 'lost_bell', seals: 0, title: undefined, gold: 5150 }, honor).head).toBe('Defeat')
    expect(rewardLines({ ...r, points: 12, rank: 0, gold: 0, seals: 0, title: undefined, parts: { damage: 12 } }, honor).lines).toEqual(['Your contribution: 12 points (too few for a reward)'])
  })

  it('the title has its label line', () => {
    expect((en as Record<string, string>)['pilot.honor.jangan_defender']).toBe('Defender of Jangan')
  })
})

describe('the siege messages on the wire (validate.ts)', () => {
  it('siegeEvent, siegeNotice, siegeReward, keg, kegEnd and EntityState.siege pass; bad ones do not', () => {
    const ok = (m: unknown) => validateServerMessage(m).ok
    expect(ok({ t: 'siegeEvent', view: { id: 1, phase: 'wave2', approaches: ['W', 'S'], nextAt: 5, endsAt: 9, bellPct: 87.5, defenders: 4, foes: 30, breaches: 1 } })).toBe(true)
    expect(ok({ t: 'siegeEvent', view: { id: 1, phase: 'wave9', approaches: [] } })).toBe(false)
    expect(ok({ t: 'siegeNotice', event: 'breach', wall: 'W3' })).toBe(true)
    expect(ok({ t: 'siegeNotice', event: 'breach', wall: 'X9' })).toBe(false)
    expect(ok({ t: 'siegeReward', reward: { event: 1, outcome: 'won', points: 300, rank: 1, of: 2, gold: 15000, seals: 6, title: 'jangan_defender', top: [{ name: 'Aki', points: 300 }], parts: { damage: 300 } } })).toBe(true)
    expect(ok({ t: 'siegeReward', reward: { event: 1, outcome: 'won', points: 300, rank: 1, of: 2, gold: 15000, seals: 6, top: [], parts: { cheese: 1 } } })).toBe(false)
    expect(ok({ t: 'keg', id: 4, seg: 'E5', x: 1, y: 2, z: 3, fuseEndsAt: 10, sapper: true, defuse: { by: 7, endsAt: 12 } })).toBe(true)
    expect(ok({ t: 'kegEnd', id: 4, how: 'defused' })).toBe(true)
    expect(ok({ t: 'kegEnd', id: 4, how: 'eaten' })).toBe(false)
    const ent = { t: 'spawn', entity: { id: 9, kind: 'mob', name: 'Town Bell', model: 'MOB_SIEGE_TOWN_BELL', level: 1, pos: [0, 0, 0], yaw: 0, siege: 'bell' } }
    const r = validateServerMessage(ent)
    expect(r.ok && r.msg.t === 'spawn' && r.msg.entity.siege).toBe('bell')
    expect(ok({ ...ent, entity: { ...ent.entity, siege: 'cook' } })).toBe(false)
  })
})
