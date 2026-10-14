/**
 * Ghost Walk - Phantom (the retail `tele` param, skills/dash.ts): the server moves the caster to the clicked point (at
 * most the reach) or straight ahead, clipped by the navmesh and the water, and refuses it while stunned or mounted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Cos } from '../src/world.ts'
import { skillHarness } from './skills-fixtures.ts'

const GW = 'SKILL_CH_LIGHTNING_GYEONGGONG_B_01'
let h: ReturnType<typeof skillHarness>
afterEach(() => h?.cleanup())

function setup(opts: Parameters<typeof skillHarness>[0] = {}) {
  h = skillHarness(opts)
  const hero = h.hero({ level: 10 })
  h.learn(hero.p, [GW])
  return hero
}

const at = (p: Parameters<typeof h.world.positionAt>[0]) => {
  const [x, , z] = h.world.positionAt(p, h.now)
  return [Math.round(x * 100) / 100, Math.round(z * 100) / 100]
}

describe('Ghost Walk - Phantom', () => {
  it('glides to the clicked point, at most the reach (10 m), over 500 ms, with a dash displace for the viewers', () => {
    const { p, inbox } = setup()
    h.req(p, { t: 'useSkill', skill: GW, pos: [0, 30] })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    expect(h.all(inbox, 'cast').at(-1)).toMatchObject({ skill: GW, actionMs: 500 })
    expect(h.all(inbox, 'displace').at(-1)).toMatchObject({ id: p.id, kind: 'dash', ms: 500, to: [0, 0, 10], skill: GW })
    h.runTo(h.now + 250)
    expect(at(p)).toEqual([0, 5])
    h.runTo(h.now + 400)
    expect(at(p)).toEqual([0, 10])
    // no buff is left behind
    expect(h.gameplay.skills.effects.list(p.id)).toEqual([])
  })

  it('a point within reach is reached exactly; no point dashes the full reach along the facing', () => {
    const { p } = setup()
    h.req(p, { t: 'useSkill', skill: GW, pos: [3, 4] })
    h.runTo(h.now + 600)
    expect(at(p)).toEqual([3, 4])
    h.runTo(h.now + 5000) // cooldown
    p.yaw = Math.PI / 2 // facing +x
    h.req(p, { t: 'useSkill', skill: GW })
    h.runTo(h.now + 600)
    expect(at(p)).toEqual([13, 4])
  })

  it('stops at a navmesh wall and before water', () => {
    // a wall at x = 5
    const { p } = setup({ move: (f, t) => [Math.min(t[0], 5), f[1], t[2]] })
    h.req(p, { t: 'useSkill', skill: GW, pos: [20, 0] })
    h.runTo(h.now + 600)
    expect(at(p)).toEqual([5, 0])
    h.runTo(h.now + 5000)
    // water beyond z = 4
    h.gameplay.tornado.wet = (_x, z) => z > 4
    h.req(p, { t: 'useSkill', skill: GW, pos: [5, 20] })
    h.runTo(h.now + 600)
    const [, z] = at(p)
    expect(z).toBeGreaterThan(3)
    expect(z).toBeLessThanOrEqual(4)
  })

  it('the caster cannot walk off mid-dash; the move after it is accepted again', () => {
    const { p } = setup()
    h.req(p, { t: 'useSkill', skill: GW, pos: [0, 10] })
    expect(h.gameplay.onMoveTo(p, h.now + 100)).toBe(false)
    h.runTo(h.now + 600)
    expect(h.gameplay.onMoveTo(p, h.now)).toBe(true)
  })

  it('is refused while stunned (rooted in place) or mounted; nothing moves and no cooldown starts', () => {
    const { p, inbox } = setup()
    h.gameplay.skills.effects.add({ instance: 999, carrier: p.id, source: p.id, kind: 'status', status: 'stun', overlap: 0, mods: [], startedAt: h.now, until: h.now + 1000 })
    h.req(p, { t: 'useSkill', skill: GW, pos: [0, 10] })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: false, reason: 'cant_act' })
    h.runTo(h.now + 1100)
    const ride = vi.spyOn(h.gameplay.mounts, 'ridden').mockReturnValue({} as Cos)
    h.req(p, { t: 'useSkill', skill: GW, pos: [0, 10] })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: false, reason: 'mounted' })
    ride.mockRestore()
    expect(h.all(inbox, 'displace')).toEqual([])
    expect(at(p)).toEqual([0, 0])
    // and then it works
    h.req(p, { t: 'useSkill', skill: GW, pos: [0, 10] })
    expect(h.result(inbox, 'useSkill')).toMatchObject({ ok: true })
  })
})
