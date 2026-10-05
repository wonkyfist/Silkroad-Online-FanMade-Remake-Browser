/**
 * Play the Boss, layer 2 (docs/PLAY_THE_BOSS.md §3.5, §3.6, §7): the kit (Claw, Sweep, Curse through MobSkills.use;
 * Pounce, Fear Roar, Call the Pack, Stalk server-built), the checks of `pilotAct` (§3.2: kit, held / busy, 500 ms,
 * cooldown, charges, known and attackable target, reach with an 8 m walk-in), the taunts and the hunt's signals (pings,
 * footprints, roars), on the in-process harness.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { castIdOf } from '../src/pilot/kit.ts'
import { bearing } from '../src/pilot/steer.ts'
import { pilotHarness, type PilotHarness } from './pilot-harness.ts'

let H: PilotHarness | null = null
afterEach(() => {
  H?.cleanup()
  H = null
})

/** The kit tests jump the clock: her idle handover waits the longest it may (120 s) so the pilot keeps her. */
const longIdle = (f: Parameters<NonNullable<Parameters<typeof pilotHarness>[0]>['file']>[0]) => {
  f.uniques[0].pilot!.defaults.hunt = { ...f.uniques[0].pilot!.defaults.hunt, idleSec: 120 }
}

function setup(o: Parameters<typeof pilotHarness>[0] = {}) {
  H = pilotHarness({ file: longIdle, ...o })
  const m = H.spawn()
  // Her at a known spot (the GM spawn rolls a point in the camp's 40 m circle).
  H.h.world.warp(m, 0, 0, 0, H.h.now)
  const pc = H.player(150, 150, 'Pixi')
  expect(H.gm('attach', 'Pixi').ok).toBe(true)
  H.tick(300)
  return { ...H, m, pc }
}

const act = (s: ReturnType<typeof setup>, msg: Record<string, unknown>) => {
  s.req(s.pc.p, { t: 'pilotAct', ...msg } as never)
  return s.result(s.pc.inbox, 'pilotAct')!
}

describe('pilotAct checks (§3.2)', () => {
  it('claw on a hunter in reach: her retail row (cast + 2 hits); then cooldown; the 500 ms gap; unknown ability', () => {
    const s = setup()
    const hunter = s.player(4, 0, 'Hunter')
    s.tick(300)
    expect(act(s, { ability: 'claw', target: hunter.p.id })).toMatchObject({ ok: true })
    expect(s.h.all(hunter.inbox, 'cast').at(-1)).toMatchObject({ id: s.m.id, skill: 'MSKILL_CH_TIGERWOMAN_ATTACK01', target: hunter.p.id })
    s.tick(1200)
    expect(s.h.all(hunter.inbox, 'combat').some((c) => c.attacker === s.m.id && c.target === hunter.p.id && c.hits.length === 2)).toBe(true)
    s.tick(1500)
    expect(act(s, { ability: 'claw', target: hunter.p.id })).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(act(s, { ability: 'nope' })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('busy inside her cast window; 500 ms between acts', () => {
    const s = setup()
    const hunter = s.player(4, 0, 'Hunter')
    s.tick(300)
    expect(act(s, { ability: 'claw', target: hunter.p.id })).toMatchObject({ ok: true })
    expect(act(s, { ability: 'curse', target: hunter.p.id })).toMatchObject({ ok: false, reason: 'busy' })
  })

  it('an act pressed while she is busy waits for her (queued, checked again), then auto-claw resumes', () => {
    const s = setup()
    const hunter = s.player(4, 0, 'Hunter')
    s.tick(300)
    expect(act(s, { ability: 'claw', target: hunter.p.id, repeat: true })).toMatchObject({ ok: true })
    s.tick(600)
    expect(s.g.mobSkills.busy(s.m, s.h.now)).toBe(true)
    expect(act(s, { ability: 'sweep' })).toMatchObject({ ok: true })
    const sweeps = () => s.h.all(hunter.inbox, 'cast').filter((c) => c.id === s.m.id && c.skill === 'MSKILL_CH_TIGERWOMAN_ATTACK02').length
    expect(sweeps()).toBe(0)
    s.tick(2500)
    expect(sweeps()).toBe(1)
    // The claw comes back after the sweep's 4 s action and the claw's cooldown.
    const claws = () => s.h.all(hunter.inbox, 'cast').filter((c) => c.id === s.m.id && c.skill === 'MSKILL_CH_TIGERWOMAN_ATTACK01').length
    const n = claws()
    s.tick(5000)
    expect(claws()).toBeGreaterThan(n)
    // A queued act whose wait runs out is dropped; a move cancels a queued act.
    expect(act(s, { ability: 'curse', target: hunter.p.id })).toMatchObject({ ok: true })
    s.moveTo(s.pc.p, 0, 20)
    s.tick(6000)
    expect(s.h.all(hunter.inbox, 'cast').some((c) => c.id === s.m.id && c.skill === 'MSKILL_CH_TIGERWOMAN_ATTACK03')).toBe(false)
  })

  it('a target the pilot does not see: not_found; the body in a trance or a far hunter: invalid_target / too_far', () => {
    const s = setup()
    const far = s.player(80, 0, 'Far')
    const unseen = s.player(-400, 400, 'Unseen')
    s.tick(300)
    expect(act(s, { ability: 'claw', target: unseen.p.id })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(act(s, { ability: 'claw', target: far.p.id })).toMatchObject({ ok: false, reason: 'too_far' })
    expect(act(s, { ability: 'claw', target: s.m.id })).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(act(s, { ability: 'claw' })).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('out of reach by ≤ 8 m: she walks into reach, then claws', () => {
    const s = setup()
    const hunter = s.player(11, 0, 'Hunter')
    s.tick(300)
    expect(act(s, { ability: 'claw', target: hunter.p.id })).toMatchObject({ ok: true })
    s.tick(100)
    expect(s.m.move).not.toBeNull()
    s.tick(1500)
    expect(s.h.all(hunter.inbox, 'cast').some((c) => c.id === s.m.id && c.skill === 'MSKILL_CH_TIGERWOMAN_ATTACK01')).toBe(true)
  })

  it('repeat (a click on a hunter): auto-claw swings again when the row is ready, chasing him', () => {
    const s = setup()
    const hunter = s.player(4, 0, 'Hunter')
    s.tick(300)
    expect(act(s, { ability: 'claw', target: hunter.p.id, repeat: true })).toMatchObject({ ok: true })
    s.tick(7000)
    expect(s.h.all(hunter.inbox, 'cast').filter((c) => c.id === s.m.id && c.skill === 'MSKILL_CH_TIGERWOMAN_ATTACK01').length).toBeGreaterThanOrEqual(2)
    // A moveTo ends it.
    s.moveTo(s.pc.p, 0, 30)
    const n = s.h.all(hunter.inbox, 'cast').length
    s.tick(5000)
    expect(s.h.all(hunter.inbox, 'cast').length).toBe(n)
  })

  it('sweep without a target: the nearest hunter in reach (area around her); none in reach: too_far', () => {
    const s = setup()
    expect(act(s, { ability: 'sweep' })).toMatchObject({ ok: false, reason: 'too_far' })
    const a = s.player(4, 0, 'Near')
    const b = s.player(0, 4.5, 'Near2')
    s.tick(600)
    expect(act(s, { ability: 'sweep' })).toMatchObject({ ok: true })
    s.tick(100)
    const hit = (inbox: typeof a.inbox, id: number) => s.h.all(inbox, 'combat').some((c) => c.attacker === s.m.id && c.target === id && c.skill === 'MSKILL_CH_TIGERWOMAN_ATTACK02')
    expect(hit(a.inbox, a.p.id)).toBe(true)
    expect(hit(b.inbox, b.p.id)).toBe(true)
  })

  it('curse at 14 m: the ranged row with its zombie status', () => {
    const s = setup()
    const hunter = s.player(14, 0, 'Hunter')
    s.tick(300)
    expect(act(s, { ability: 'curse', target: hunter.p.id })).toMatchObject({ ok: true })
    s.tick(4000)
    expect(s.h.all(hunter.inbox, 'combat').some((c) => c.attacker === s.m.id && c.skill === 'MSKILL_CH_TIGERWOMAN_ATTACK03')).toBe(true)
    expect(s.h.all(hunter.inbox, 'effectAdd').some((e) => e.id === hunter.p.id && e.effect.status === 'zombie')).toBe(true)
  })
})

describe('Pounce (§3.5)', () => {
  it('to a ground point at 24 m/s: lands, hits the hunters within 3 m with the knockdown; 12 s cooldown', () => {
    const s = setup()
    const hunter = s.player(10, 1, 'Hunter')
    s.tick(300)
    expect(act(s, { ability: 'pounce', x: 10, z: 0 })).toMatchObject({ ok: true })
    expect(s.m.move!.speed).toBe(24)
    expect(s.h.all(hunter.inbox, 'cast').at(-1)).toMatchObject({ id: s.m.id, skill: castIdOf('MOB_CH_TIGERWOMAN', 'pounce'), clip: 'ATTACK1' })
    expect(castIdOf('MOB_CH_TIGERWOMAN', 'pounce')).toBe('PILOT_TIGERWOMAN_POUNCE')
    s.tick(700)
    expect(s.h.all(hunter.inbox, 'combat').some((c) => c.attacker === s.m.id && c.target === hunter.p.id && c.skill === 'PILOT_TIGERWOMAN_POUNCE')).toBe(true)
    expect(s.h.all(hunter.inbox, 'effectAdd').some((e) => e.id === hunter.p.id && e.effect.status === 'knockdown')).toBe(true)
    s.tick(1000)
    expect(act(s, { ability: 'pounce', x: 0, z: 0 })).toMatchObject({ ok: false, reason: 'cooldown' })
  })

  it('more than 12 m: too_far; a wall stops the leap at the wall', () => {
    const s = setup({ wallX: 5 })
    expect(act(s, { ability: 'pounce', x: 20, z: 0 })).toMatchObject({ ok: false, reason: 'too_far' })
    expect(act(s, { ability: 'pounce', x: 11, z: 0 })).toMatchObject({ ok: true })
    s.tick(1000)
    const at = s.h.world.positionAt(s.m, s.h.now)
    expect(at[0]).toBeLessThan(5)
    expect(at[0]).toBeGreaterThan(4.5)
  })
})

describe('Fear Roar (§3.5)', () => {
  it('hunters within 8 m: knocked back, pushed 5 m away, and their moveTo / attack refused for 1.5 s (cant_act)', () => {
    const s = setup()
    const near = s.player(5, 0, 'Near')
    const far = s.player(20, 0, 'Far')
    s.tick(300)
    expect(act(s, { ability: 'roar' })).toMatchObject({ ok: true })
    expect(s.h.all(near.inbox, 'cast').at(-1)).toMatchObject({ id: s.m.id, clip: 'FIND' })
    expect(s.h.all(near.inbox, 'effectAdd').some((e) => e.id === near.p.id && e.effect.status === 'knockback')).toBe(true)
    expect(near.p.move).not.toBeNull()
    expect(near.p.move!.to[0]).toBeCloseTo(10)
    expect(far.p.move).toBeNull()
    expect(s.g.onMoveTo(near.p, s.h.now)).toBe(false)
    s.req(near.p, { t: 'attack', target: s.m.id })
    expect(s.result(near.inbox, 'attack')).toMatchObject({ ok: false, reason: 'cant_act' })
    s.tick(1600)
    expect(s.g.onMoveTo(near.p, s.h.now)).toBe(true)
  })
})

describe('Call the Pack (§3.5)', () => {
  it('2 White Tigers beside her, on her target, adopted into her summons; 2 charges; they leave with her', () => {
    const s = setup()
    const hunter = s.player(6, 0, 'Hunter')
    s.tick(300)
    expect(act(s, { ability: 'pack', target: hunter.p.id })).toMatchObject({ ok: true })
    const pack = [...s.h.world.mobs.values()].filter((m) => m.def.code === 'MOB_CH_WHITETIGER')
    expect(pack).toHaveLength(2)
    for (const w of pack) {
      expect(s.g.mobSkills.summonerOf(w.id)).toBe(s.m.id)
      expect(w.target).toBe(hunter.p.id)
      expect(Math.hypot(w.pos[0] - s.m.pos[0], w.pos[2] - s.m.pos[2])).toBeLessThanOrEqual(3.6)
    }
    expect(s.last(s.pc.inbox, 'pilotState')!.charges.pack).toBe(1)
    s.h.now += 31_000
    s.tick(100)
    expect(act(s, { ability: 'pack' })).toMatchObject({ ok: true })
    s.h.now += 31_000
    s.tick(100)
    expect(act(s, { ability: 'pack' })).toMatchObject({ ok: false, reason: 'no_charges' })
    expect(s.g.mobSkills.dismissSummons(s.m)).toBe(4)
  })
})

describe('Stalk (§3.5)', () => {
  it('a hunter at 9 m loses her within one interest pass, one at 7 m keeps her, staff and her pilot keep her; speed ×0.4', () => {
    const s = setup()
    const at9 = s.player(9, 0, 'Nine')
    const at7 = s.player(7, 0, 'Seven')
    const staff = s.player(30, 0, 'Staff')
    staff.p.staff = true
    s.tick(300)
    expect(at9.p.known.has(s.m.id)).toBe(true)
    expect(act(s, { ability: 'stalk' })).toMatchObject({ ok: true })
    s.tick(250)
    expect(at9.p.known.has(s.m.id)).toBe(false)
    expect(s.h.all(at9.inbox, 'despawn').some((d) => d.id === s.m.id)).toBe(true)
    expect(at7.p.known.has(s.m.id)).toBe(true)
    expect(staff.p.known.has(s.m.id)).toBe(true)
    expect(s.pc.p.known.has(s.m.id)).toBe(true)
    s.moveTo(s.pc.p, 0, -30)
    expect(s.m.move!.speed).toBeCloseTo(3.6)
    expect(s.last(s.pc.inbox, 'pilotState')!.stalkUntil).toBeGreaterThan(s.h.now)
  })

  it('ends on damage taken (she shows again; the 25 s cooldown starts) and after 20 s', () => {
    const s = setup()
    const at9 = s.player(9, 0, 'Nine')
    const hitter = s.player(3, 0, 'Hitter')
    s.tick(300)
    expect(act(s, { ability: 'stalk' })).toMatchObject({ ok: true })
    s.tick(300)
    expect(at9.p.known.has(s.m.id)).toBe(false)
    s.g.dealHits(hitter.p, s.m, [{ outcome: 'hit', damage: 10, hp: 0 }], {}, s.h.now)
    expect(s.m.veil).toBeUndefined()
    s.tick(300)
    expect(at9.p.known.has(s.m.id)).toBe(true)
    expect(act(s, { ability: 'stalk' })).toMatchObject({ ok: false, reason: 'cooldown' })
    s.h.now += 26_000
    s.tick(100)
    expect(act(s, { ability: 'stalk' })).toMatchObject({ ok: true })
    s.tick(20_500)
    expect(s.m.veil).toBeUndefined()
  })
})

describe('taunts (§3.6)', () => {
  it('a fixed line to her viewers; 4 s cooldown; an unknown line refused', () => {
    const s = setup()
    const hunter = s.player(10, 0, 'Hunter')
    s.tick(300)
    s.req(s.pc.p, { t: 'pilotTaunt', line: 5 })
    expect(s.result(s.pc.inbox, 'pilotTaunt')).toMatchObject({ ok: true })
    expect(s.last(hunter.inbox, 'huntTaunt')).toEqual({ t: 'huntTaunt', id: s.m.id, line: 5 })
    s.req(s.pc.p, { t: 'pilotTaunt', line: 2 })
    expect(s.result(s.pc.inbox, 'pilotTaunt')).toMatchObject({ ok: false, reason: 'cooldown' })
    s.tick(4100)
    s.req(s.pc.p, { t: 'pilotTaunt', line: 9 })
    expect(s.result(s.pc.inbox, 'pilotTaunt')).toMatchObject({ ok: false, reason: 'not_found' })
  })
})

describe('the hunt signals (§3.6)', () => {
  it('bearing: 0 = east, π/2 = north (−Z)', () => {
    expect(bearing(0, 0, 10, 0)).toBeCloseTo(0)
    expect(bearing(0, 0, 0, -10)).toBeCloseTo(Math.PI / 2)
    expect(bearing(0, 0, -10, 0)).toBeCloseTo(Math.PI)
  })

  it('in a hunt: a ping at +60 s to everyone but the pilot (a circle containing her); roars to hunters 120–400 m away; footprints near hunters who do not see her', () => {
    H = pilotHarness({ file: longIdle })
    const s = H
    const m = s.spawn()
    s.h.world.warp(m, 0, 0, 0, s.h.now)
    const pc = s.player(150, 150, 'Pixi')
    const far = s.player(0, 250, 'Far')
    // Near where she starts: he sees her at first, then only her tracks once she is out of sight.
    const tracker = s.player(-30, 0, 'Tracker')
    expect(s.gm('Pixi').ok).toBe(true)
    s.req(pc.p, { t: 'pilotAnswer', event: s.last(pc.inbox, 'pilotOffer')!.event, accept: true })
    expect(s.result(pc.inbox, 'pilotAnswer')).toMatchObject({ ok: true })
    // She runs east, away from the tracker (footprints every 3 s).
    s.moveTo(pc.p, 300, 0)
    s.tick(31_000)
    const roar = s.last(far.inbox, 'huntRoar')!
    expect(roar).toBeDefined()
    expect(roar.distM).toBeGreaterThanOrEqual(120)
    expect(roar.distM).toBeLessThanOrEqual(400)
    expect(s.h.all(pc.inbox, 'huntRoar')).toHaveLength(0)
    const trail = s.h.all(tracker.inbox, 'huntTrail')
    expect(trail.length).toBeGreaterThan(0)
    expect(tracker.p.known.has(m.id)).toBe(false)
    expect(trail.flatMap((t) => t.points).every(([x, z]) => Math.hypot(x + 30, z) <= 40.01)).toBe(true)
    s.tick(30_000)
    const ping = s.last(far.inbox, 'huntPing')!
    expect(ping).toBeDefined()
    const her = s.h.world.positionAt(m, s.h.now)
    expect(Math.hypot(ping.x - her[0], ping.z - her[2])).toBeLessThanOrEqual(ping.r)
    expect(s.h.all(pc.inbox, 'huntPing')).toHaveLength(0)
  })
})
